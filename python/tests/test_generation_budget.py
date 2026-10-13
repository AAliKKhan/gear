"""Author recipes adapt their plans to core-owned generation capacity."""
import unittest
from dataclasses import replace

from gear.algorithms import (
    GEPA, RandomSearch, AlgorithmState, Budget, Candidate, Evidence, OperationResult,
    SearchView, Task,
)
from gear.canonical import digest


class GenerationBudgetTests(unittest.TestCase):
    def view(self, capacity):
        return SearchView(
            'generation-budget', 1, 'fixed', (Task('a', 'family'),),
            (Candidate('anchor', digest('anchor')),),
            (Evidence('anchor', 'a', 0, 0, 'valid', 'global'),), (),
            Budget(20, 3, 1, generation_requests_remaining=capacity,
                   generation_tokens_remaining=capacity, generation_batch_capacity=capacity),
            'anchor',
        )

    def test_exhaustion_stops_before_another_diagnosis_or_generation(self):
        for recipe in (GEPA, RandomSearch):
            view = self.view(0)
            for state in (
                AlgorithmState(data={'phase': 'parents', 'round': 0}),
                AlgorithmState(data={'phase': 'proposals', 'round': 0}),
            ):
                with self.subTest(recipe=recipe.__name__, phase=state.data['phase']):
                    decision = recipe().step(view, state)
                    self.assertEqual(decision.operations[0].kind, 'stop')
                    self.assertIn('generation budget exhausted', decision.reason)

    def test_proposal_count_is_bounded_by_affordable_batch_capacity(self):
        for recipe in (GEPA, RandomSearch):
            view = replace(self.view(1), completed=(OperationResult(
                'diagnosis', 'diagnose_seed', 'complete', 'anchor',
                {'hypotheses': ['one', 'two', 'three']},
            ),))
            state = AlgorithmState(data={'phase': 'proposals', 'round': 0,
                'parent': 'anchor', 'limit': 3, 'failures': ['a'], 'batch_index': 0})
            decision = recipe().step(view, state)
            self.assertEqual(len(decision.operations), 1)
            self.assertEqual(decision.operations[0].kind, 'generate_candidate')

    def test_exhausted_generation_does_not_discard_an_already_evaluated_nominee(self):
        view = replace(self.view(0), candidates=self.view(0).candidates + (Candidate('best', digest('best')),),
            evidence=self.view(0).evidence + (Evidence('best', 'a', 0, 1, 'valid', 'global'),))
        decision = GEPA().step(view, AlgorithmState(data={'phase': 'proposals', 'round': 0}))
        self.assertEqual(decision.operations[0].kind, 'nominate')
        self.assertEqual(decision.operations[0].candidate_id, 'best')
