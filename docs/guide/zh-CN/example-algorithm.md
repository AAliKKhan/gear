# 用 Python 修改算法

公开作者 API 是 `gear.algorithms`。GEPA 和 RandomSearch 都由父代、采样、提案、排名、停止和阶段编排六个模块组成；GEPA 是公共模块合同的实例。

下面用一个命名函数替换父代策略：

```python
# my_policy.py
from gear.algorithms import ParentInput, ParentPlan, RandomSource


def select_parent(view: ParentInput, rng: RandomSource) -> ParentPlan:
    if not view.eligible:
        return ParentPlan.abstain("no eligible parent")
    return ParentPlan.single(rng.choice(view.eligible, key="parent"), view.candidate_limit)
```

```sh
python -m gear algorithm test my_policy:select_parent
python -m gear algorithm test gepa
python -m gear algorithm test random-search
```

```python
from gear import Project
from gear.algorithms import GEPA
from my_policy import select_parent

run = Project.open(".").refine(algorithm=GEPA(parent_policy=select_parent), rounds=1)
print(run.report.summary)
```

前三个测试只需要基础 Python 包，不调用模型。真实项目调用需要 npm runtime 和已配置的执行 profiles。Notebook 使用 `await project.arefine(...)`。

从 [六模块索引](../../search-algorithm-authoring.zh-CN.md)定位代码和类型合同。策略输入只有允许的 seed 投影，返回 JSON 状态和明确操作。运行层负责预算、执行、证据身份、held-out gate 和 champion CAS。

源码与声明依赖在 admission 时冻结；局部函数、lambda 和未声明的依赖不能作为可恢复的算法配置。修改代码产生新身份。历史 TS selector/search 子路径已从公开导出中移除。
