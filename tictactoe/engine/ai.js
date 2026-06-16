'use strict';

const { checkWinner, isDraw, emptyCells } = require('./game');

// Easy: random empty cell (Fisher-Yates partial shuffle).
function easyMove(board) {
  const empty = emptyCells(board);
  for (let i = empty.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = empty[i];
    empty[i] = empty[j];
    empty[j] = tmp;
  }
  return empty[0];
}

// Medium: win > block > center > corner > any.
function mediumMove(board, aiPlayer) {
  const opponent = aiPlayer === 'X' ? 'O' : 'X';
  const empty = emptyCells(board);

  // 1. Win immediately
  for (const cell of empty) {
    const next = board.slice();
    next[cell] = aiPlayer;
    if (checkWinner(next)) return cell;
  }

  // 2. Block opponent win
  for (const cell of empty) {
    const next = board.slice();
    next[cell] = opponent;
    if (checkWinner(next)) return cell;
  }

  // 3. Center
  if (board[4] === null) return 4;

  // 4. Corner
  const corners = [0, 2, 6, 8].filter((c) => board[c] === null);
  if (corners.length) return corners[0];

  // 5. Any
  return empty[0];
}

// Hard: minimax with alpha-beta pruning. The 3×3 tree is tiny (≤362 880 nodes).
// A correct minimax on a standard board never loses — it always draws or wins.
function hardMove(board, aiPlayer) {
  const opponent = aiPlayer === 'X' ? 'O' : 'X';

  function score(b, isMax, alpha, beta, depth) {
    const w = checkWinner(b);
    if (w) return w.winner === aiPlayer ? 10 - depth : depth - 10;
    if (isDraw(b)) return 0;

    const cells = emptyCells(b);
    if (isMax) {
      let best = -Infinity;
      for (const cell of cells) {
        const next = b.slice();
        next[cell] = aiPlayer;
        const s = score(next, false, alpha, beta, depth + 1);
        if (s > best) best = s;
        if (s > alpha) alpha = s;
        if (beta <= alpha) break;
      }
      return best;
    } else {
      let best = Infinity;
      for (const cell of cells) {
        const next = b.slice();
        next[cell] = opponent;
        const s = score(next, true, alpha, beta, depth + 1);
        if (s < best) best = s;
        if (s < beta) beta = s;
        if (beta <= alpha) break;
      }
      return best;
    }
  }

  const empty = emptyCells(board);
  let bestScore = -Infinity;
  let bestCell = empty[0];

  for (const cell of empty) {
    const next = board.slice();
    next[cell] = aiPlayer;
    const s = score(next, false, -Infinity, Infinity, 0);
    if (s > bestScore) {
      bestScore = s;
      bestCell = cell;
    }
  }

  return bestCell;
}

// Main entry point. difficulty: 'easy' | 'medium' | 'hard'.
function getAIMove(board, difficulty, aiPlayer) {
  switch (difficulty) {
    case 'easy':   return easyMove(board);
    case 'medium': return mediumMove(board, aiPlayer);
    case 'hard':   return hardMove(board, aiPlayer);
    default:       return easyMove(board);
  }
}

module.exports = { getAIMove };
