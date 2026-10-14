# 独立评测推理服务

Gear 评测可使用 `agent-hitch/packages/inference` 中独立安装的普通推理服务。训练 rollout、精确 token/logprob 回执、Slime 策略更新和逐 episode 执行保持现有行为；Harbor/Docker 继续运行任务与 verifier。

先将独立 wheel 安装到模型节点的同一 Python 环境，再冻结新实验：

```sh
python3 -m pip install '/path/to/agent-hitch/packages/inference[sglang]'
```

与训练节点复用相同的绝对 `nodeRoot`、`storeRoot`，共享 OS boot generation、`device-leases.json`、`device-leases.lock` 与历史启动证明。在节点或 job 配置中设置 `deviceLeaseRuntime: "standalone-v1"` 可直接选用已安装的共享账本实现；缺少安装会明确失败。旧配置保留 `gear-legacy-v2` 兼容实现及完全相同的账本路径、schema 和锁。安装变化会改变运行时身份，需要新 baseline，不能修改历史记录凑匹配。

v2 实验可显式设置 `evaluation.inferencePool`，完整 JSON 字段与示例见[英文协议说明](standalone-inference.md)。其中 `tensorParallelSize` 表示单引擎 TP；`replicas` 是互不重叠、每组恰好 TP 个物理 GPU UUID 的列表；`maxRunningRequests`、`maxQueuedRequests` 约束整个池；`maxConcurrent` 控制同时执行的评测 trial。每个引擎的 SGLang DP/PP 仍为 1。副本设备集合必须恰好覆盖 `resources.evaluationDevices`，`evaluation.samplingProfile` 必须与池 profile 一致。

从独立 `hitch-inference plan` 输出的 `lock.model_node` 获取真实 `node_id`、`generation`、`runtime_digest`。独立推理运行时摘要可与 Gear 训练摘要不同，但节点 ID、OS boot generation 必须一致。不要用训练摘要冒充新服务的观察结果。配置 `hitch.budgets.maxConcurrent` 与池并发一致，重新计算完整 budgetsDigest；通过 Hitch 的 `local plan --pool-file ... --profile ...` 准备 baseline，并冻结 common runtime/protocol/generation 摘要。

common runtime 摘要包括引擎运行时、execution、resources、模型节点身份与副本拓扑，候选权重只属于 subject。Gear 还冻结 inferencePoolDigest；改变副本、容量、并发或节点需要新 baseline，不能复用旧成对证据。评测使用完整 GPU 池、传递实际 trial 并发，并合计所有副本的累计 GPU 秒。顺序 train↔evaluation 切换必须等待全部进程死亡及物理 GPU 空闲得到确认。单请求取消只关闭该请求，客户端释放不会杀死共享部署；drain 和 stop 在确认资源释放前持续保留所有权。

历史 v1/v2 单卡锁、Docker API 与结果保持原始身份，不会被改写为 v3。新的显式池使用独立节点入口；无实验时普通 OpenAI 推理也可单独运行。CPU 测试覆盖真实分离进程和 HTTP，但 2 GPU/TP2、4 GPU/TP2×2 副本仍须按独立包的硬件 smoke 在目标主机验收，本改动不声明训练 rollout 并发或 GPU 硬件认证。
