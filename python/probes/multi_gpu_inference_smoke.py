"""Physical two-GPU ordinary API acceptance; no fake engines or model downloads."""
import argparse
import concurrent.futures
import http.client
import json
import os
from pathlib import Path
import queue
import secrets
import subprocess
import sys
import threading
import time


def gpu_samples():
    result = subprocess.run(['nvidia-smi', '--query-gpu=uuid,utilization.gpu,memory.used',
                             '--format=csv,noheader,nounits'], capture_output=True, text=True, check=True, timeout=10)
    return [{'uuid': fields[0], 'utilization': int(fields[1]), 'memory_mib': int(fields[2])}
            for line in result.stdout.splitlines() if (fields := [p.strip() for p in line.split(',')])]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    from hitch_inference.plan import plan
    from hitch_inference.hardware import gpu_processes
    devices = [r['uuid'] for r in gpu_samples()]
    assert len(devices) == 2 and not gpu_processes(devices), 'require two empty physical GPUs'
    config = {'schemaVersion': 2, 'nodeId': 'vast-dual-gpu-smoke', 'nodeRoot': str(args.output / 'node'),
              'storeRoot': str(args.output / 'cas'), 'port': 0}
    config_path = args.output / 'node.json'
    config_path.write_text(json.dumps(config))
    api_token, admin_token = secrets.token_hex(32), secrets.token_hex(32)
    env = {**os.environ, 'HITCH_INFERENCE_API_TOKEN': api_token, 'HITCH_INFERENCE_MANAGEMENT_TOKEN': admin_token}
    report = {'kind': 'physical-inference-acceptance', 'devices': devices, 'status': 'running', 'cases': []}
    server, current = None, None
    started = time.monotonic()
    port = None

    def call(method, route, body=None, admin=False):
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=650)
        try:
            connection.request(method, route, None if body is None else json.dumps(body),
                {'Authorization': 'Bearer ' + (admin_token if admin else api_token), 'Content-Type': 'application/json'})
            response = connection.getresponse()
            result = json.loads(response.read())
            assert 200 <= response.status < 300, (response.status, result)
            return result
        finally:
            connection.close()

    try:
        with (args.output / 'server.log').open('w') as errors:
            server = subprocess.Popen([sys.executable, '-m', 'hitch_inference.http_server', '--config', str(config_path)],
                env=env, stdout=subprocess.PIPE, stderr=errors, text=True, start_new_session=True)
            announced = queue.Queue()
            threading.Thread(target=lambda: announced.put(server.stdout.readline()), daemon=True).start()
            announcement = json.loads(announced.get(timeout=30))
            port = announcement['port']
            questions = ['Compute 17 times 23. Explain the calculation briefly and give the final integer.',
                         'A train travels 60 km per hour for 2.5 hours. How far does it travel? Explain briefly.',
                         'Solve 3*x + 7 = 22. Show the short calculation and give x.']
            report['questions'] = questions
            for name, replicas, count, profile in [('tp1-replicas2', [[d] for d in devices], 3, 'throughput'),
                                                   ('tp2-replicas1', [devices], 1, 'baseline')]:
                current = plan(config, args.model, replicas, profile, running=2 if profile == 'throughput' else 1, queued=4)
                (args.output / (name + '-plan.json')).write_text(json.dumps(current, indent=2))
                call('POST', '/deployments', current, admin=True)
                deadline = time.monotonic() + 650
                while True:
                    status = call('GET', '/deployments/' + current['serviceId'], admin=True)
                    assert status['state'] not in ('failed', 'stopped'), status
                    if status['state'] == 'ready':
                        break
                    assert time.monotonic() < deadline, 'engine startup timeout'
                    time.sleep(1)
                case = {'name': name, 'inference_id': current['lock']['inference_id'],
                        'observations': status['replicaObservations'], 'samples': [], 'results': []}
                report['cases'].append(case)

                def infer(index):
                    start = time.monotonic()
                    value = call('POST', '/v1/chat/completions', {'model': current['lock']['inference_id'],
                        'messages': [{'role': 'user', 'content': questions[index]}],
                        'max_tokens': 128})
                    assert value.get('choices') and value.get('usage', {}).get('completion_tokens', 0) > 0, value
                    return {'task': index, 'started': start, 'finished': time.monotonic(), 'usage': value['usage'],
                            'finish_reason': value['choices'][0]['finish_reason'], 'message': value['choices'][0]['message']}

                with concurrent.futures.ThreadPoolExecutor(max_workers=count) as executor:
                    futures = [executor.submit(infer, i) for i in range(count)]
                    while not all(f.done() for f in futures):
                        observed = call('GET', '/deployments/' + current['serviceId'], admin=True)
                        case['samples'].append({'time': time.monotonic(), 'active_requests': observed.get('activeRequests', 0),
                                                'gpus': gpu_samples()})
                        time.sleep(.15)
                    case['results'] = [f.result() for f in futures]
                assert status['gpuUuids'] == devices
                if profile == 'throughput':
                    assert any(s['active_requests'] >= 2 for s in case['samples']), 'concurrent admission unobserved'
                assert any(all(g['utilization'] > 0 for g in s['gpus']) for s in case['samples']), 'both GPUs must execute during one observation'
                stopped = call('POST', '/deployments/' + current['serviceId'] + '/stop', {}, admin=True)
                assert stopped['resourcesReleased'] and not gpu_processes(devices), stopped
                case.update(status='passed', resources_released=True, gpu_seconds=stopped['gpuSeconds'])
                current = None
            report['status'] = 'passed'
    except BaseException as error:
        report.update(status='failed', error=f'{type(error).__name__}: {error}')
        raise
    finally:
        if current is not None and port is not None:
            try:
                report['cleanup'] = call('POST', '/deployments/' + current['serviceId'] + '/stop', {'force': True}, admin=True)
            except Exception as error:
                report['cleanup_error'] = type(error).__name__
        if server is not None:
            server.terminate()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait(timeout=10)
        report['elapsed_seconds'] = time.monotonic() - started
        (args.output / 'summary.json').write_text(json.dumps(report, indent=2))
        print(json.dumps({k: v for k, v in report.items() if k != 'cases'}), flush=True)


if __name__ == '__main__':
    main()
