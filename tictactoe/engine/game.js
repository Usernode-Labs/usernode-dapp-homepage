'use strict';

// Board is a flat 9-element array, row-major: index 0 = top-left, 8 = bottom-right.
// Values: null (empty), 'X', or 'O'.

const WINNING_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8], // rows
  [0, 3, 6], [1, 4, 7], [2, 5, 8], // columns
  [0, 4, 8], [2, 4, 6],             // diagonals
];

// Returns { winner: 'X'|'O', line: [a,b,c] } or null.
function checkWinner(board) {
  for (const [a, b, c] of WINNING_LINES) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return { winner: board[a], line: [a, b, c] };
    }
  }
  return null;
}

// True when all cells are filled and there is no winner.
function isDraw(board) {
  return board.every((cell) => cell !== null) && !checkWinner(board);
}

// Returns a new board with the move applied. Does not mutate the original.
function applyMove(board, cell, player) {
  const next = board.slice();
  next[cell] = player;
  return next;
}

// Returns an array of indices where the board is null.
function emptyCells(board) {
  const out = [];
  for (let i = 0; i < board.length; i++) {
    if (board[i] === null) out.push(i);
  }
  return out;
}

module.exports = { WINNING_LINES, checkWinner, isDraw, applyMove, emptyCells };
