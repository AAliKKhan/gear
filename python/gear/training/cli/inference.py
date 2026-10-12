"""Command-line entrypoint; service behavior lives in the implementation package."""

import argparse

from gear.training.inference.inference_process import engine, supervisor


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("_supervisor", "_engine"))
    parser.add_argument("--directory", required=True)
    args = parser.parse_args()
    (supervisor if args.action == "_supervisor" else engine)(args.directory)


if __name__ == "__main__":
    main()
