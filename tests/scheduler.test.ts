import { describe, expect, it } from 'vitest';
import { scheduleReview, skipChangesSchedule, type ReviewStateRow } from '../src/scheduler.js';

function newRow(at: Date): ReviewStateRow {
  return {
    knowledge_point_id: 1,
    due_at: at.toISOString(),
    state: 'new',
    stability: null,
    difficulty: null,
    reps: 0,
    lapses: 0,
    last_review_at: null,
    last_rating: null,
  };
}

describe('scheduler: FSRS-5 advances deterministically', () => {
  const now = new Date('2026-01-01T09:00:00.000Z');

  it('moves a new point into learning and increments reps on a good answer', () => {
    const scheduled = scheduleReview(newRow(now), 3, now);
    expect(scheduled.state).toBe('learning');
    expect(scheduled.reps).toBe(1);
    expect(scheduled.last_rating).toBe(3);
    expect(new Date(scheduled.due_at).getTime()).toBeGreaterThan(now.getTime());
    expect(scheduled.difficulty).toBeGreaterThan(0);
    expect(scheduled.stability).toBeGreaterThan(0);
  });

  it('schedules "again" sooner than "good" for the same card', () => {
    const again = scheduleReview(newRow(now), 1, now);
    const good = scheduleReview(newRow(now), 3, now);
    expect(new Date(again.due_at).getTime()).toBeLessThan(new Date(good.due_at).getTime());
    expect(again.lapses).toBe(0);
  });

  it('advances a card from learning into review on the second good answer', () => {
    const first = scheduleReview(newRow(now), 3, now);
    const second = scheduleReview(
      {
        knowledge_point_id: 1,
        due_at: first.due_at,
        state: first.state,
        stability: first.stability,
        difficulty: first.difficulty,
        reps: first.reps,
        lapses: first.lapses,
        last_review_at: first.last_review_at,
        last_rating: first.last_rating,
      },
      3,
      new Date(first.due_at),
    );
    expect(second.state).toBe('review');
    expect(second.reps).toBe(2);
    expect(new Date(second.due_at).getTime()).toBeGreaterThan(new Date(first.due_at).getTime());
  });

  it('is deterministic for identical (state, rating, time) inputs', () => {
    const a = scheduleReview(newRow(now), 3, now);
    const b = scheduleReview(newRow(now), 3, now);
    expect(a).toEqual(b);
  });

  it('records a lapse when an established card is answered again', () => {
    const learned = scheduleReview(newRow(now), 3, now);
    const lapsed = scheduleReview(
      {
        knowledge_point_id: 1,
        due_at: learned.due_at,
        state: 'review',
        stability: learned.stability,
        difficulty: learned.difficulty,
        reps: learned.reps,
        lapses: learned.lapses,
        last_review_at: learned.last_review_at,
        last_rating: learned.last_rating,
      },
      1,
      now,
    );
    expect(lapsed.state).toBe('relearning');
    expect(lapsed.lapses).toBe(1);
    expect(lapsed.last_rating).toBe(1);
  });

  it('skipping changes no scheduler field', () => {
    expect(skipChangesSchedule()).toBe(false);
  });
});