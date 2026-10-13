# Customize an algorithm in Python

The author API is `gear.algorithms`. GEPA and RandomSearch share six contracts:
parents, sampling, proposal, ranking, stopping and stage composition. GEPA is
an instance of these common module contracts.

Replace its parent policy with a named function:

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

The three tests require only the base Python package and make no model calls.
A real project needs the npm runtime and configured execution profiles. In a
notebook use `await project.arefine(...)`.

Use the [six-module index](../../search-algorithm-authoring.zh-CN.md) to locate
implementations and typed contracts. Policies consume authorized seed views and
return JSON state plus explicit operations. The runtime owns budgets, execution,
evidence identities, the held-out gate and champion CAS.

Admission freezes source and declared dependencies. Local functions, lambdas
and undeclared dependencies are not resumable algorithm configurations. Changed
code gets a new identity. Historical TypeScript selector/search subpaths are
no longer public exports.
