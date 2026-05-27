import { reducer } from '../../src/game/reducer';
import { playOneGame } from './_runner';

const r = playOneGame({ seed: 1001, strategies: ['mcts', 'smart', 'smart', 'smart'], maxSteps: 5000 });
console.log('finished=', r.finished, 'winnerId=', r.winnerId, 'scores=', r.scores, 'steps=', r.steps, 'turns=', r.turns);
