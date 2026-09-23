import { fsrs, generatorParameters, Rating, State, createEmptyCard } from 'ts-fsrs';
import type { Card, Grade } from 'ts-fsrs';

export type ReviewStateName = 'new' | 'learning' | 'review' | 'relearning';
export type RatingValue = 1 | 2 | 3;

export const RATING_AGAIN: RatingValue = 1;
export const RATING_HARD: RatingValue = 2;
export const RATING_GOOD: RatingValue = 3;

// ts-fsrs 5.x typed the review input as `Grade` (every rating except Manual),
// so an explicit `Rating` annotation here is rejected by tsc.
const RATING_TO_FSRS: Record<RatingValue, Grade> = {
  1: Rating.Again,
  2: Rating.Hard,
  3: Rating.Good,
};

const STATE_FROM_NAME: Record<ReviewStateName, State> = {
  new: State.New,
  learning: State.Learning,
  review: State.Review,
  relearning: State.Relearning,
};

const NAME_FROM_STATE: readonly ReviewStateName[] = ['new', 'learning', 'review', 'relearning'];

const engine = fsrs(generatorParameters({ request_retention: 0.9, enable_fuzz: false }));

export interface ReviewStateRow {
  knowledge_point_id: number;
  due_at: string;
  state: string;
  stability: number | null;
  difficulty: number | null;
  reps: number;
  lapses: number;
  last_review_at: string | null;
  last_rating: number | null;
}

export interface ScheduledState {
  due_at: string;
  state: ReviewStateName;
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  last_review_at: string;
  last_rating: RatingValue;
}

function stateName(value: string): ReviewStateName {
  return (NAME_FROM_STATE as readonly string[]).includes(value)
    ? (value as ReviewStateName)
    : 'new';
}

function toCard(row: ReviewStateRow): Card {
  const state = stateName(row.state);
  const base = createEmptyCard(new Date(row.due_at));
  // review_states has no column for FSRS's learning-step index, so it is
  // reconstructed here: a learning card advances one step per review (reps),
  // while the single relearning step always sits at index 0. Without this the
  // index resets to 0 on every read and a card can never graduate to review.
  const learningSteps = state === 'learning' ? row.reps : 0;
  return {
    ...base,
    due: new Date(row.due_at),
    stability: row.stability ?? 0,
    difficulty: row.difficulty ?? 0,
    reps: row.reps,
    lapses: row.lapses,
    state: STATE_FROM_NAME[state],
    last_review: row.last_review_at ? new Date(row.last_review_at) : undefined,
    learning_steps: learningSteps,
  };
}

/**
 * FSRS-5 with a fixed desired retention of 0.9 and fuzz disabled, so the due
 * date is deterministic given (state, rating, review time).
 */
export function scheduleReview(row: ReviewStateRow, rating: RatingValue, now = new Date()): ScheduledState {
  const result = engine.next(toCard(row), now, RATING_TO_FSRS[rating]);
  const card = result.card;
  return {
    due_at: card.due.toISOString(),
    state: NAME_FROM_STATE[card.state] ?? 'review',
    stability: card.stability,
    difficulty: card.difficulty,
    reps: card.reps,
    lapses: card.lapses,
    last_review_at: (card.last_review ?? now).toISOString(),
    last_rating: rating,
  };
}

/** Skipping a question changes no scheduler field; only a graded answer advances the schedule. */
export function skipChangesSchedule(): false {
  return false;
}