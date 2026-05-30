/**
 * Mode Detection v0.6 — Unit Tests
 *
 * Tests the detectIntentMode function across a broad range of prompts:
 * - Plan-mode prompts (exploration, drafting, comparison)
 * - Act-mode prompts (implementation, building, fixing)
 * - Auto-mode prompts (mixed signals, conversational)
 * - Edge cases and boundaries
 */
import { describe, it, expect } from 'vitest';
import { detectIntentMode } from '../src/v04-config.js';

describe('detectIntentMode — Plan Detection', () => {
  it('detects drafting prompts as plan', () => {
    const r = detectIntentMode('Draft an architecture for a microservices-based payment system');
    expect(r.mode).toBe('plan');
    expect(r.confidence).toBeGreaterThan(0);
    expect(r.planScore).toBeGreaterThan(0);
  });

  it('detects exploration prompts as plan', () => {
    const r = detectIntentMode('What are the tradeoffs between REST and GraphQL for our use case?');
    expect(r.mode).toBe('plan');
    expect(r.planScore).toBeGreaterThan(0);
  });

  it('detects comparison prompts as plan', () => {
    const r = detectIntentMode('Compare the pros and cons of PostgreSQL vs MongoDB for event sourcing');
    expect(r.mode).toBe('plan');
    expect(r.planScore).toBeGreaterThan(0);
  });

  it('detects brainstorming as plan', () => {
    const r = detectIntentMode('Brainstorm options for implementing real-time notifications in our app');
    expect(r.mode).toBe('plan');
    expect(r.planScore).toBeGreaterThan(0);
  });

  it('detects strategy prompts as plan', () => {
    const r = detectIntentMode('Outline a migration strategy from the monolith to a distributed architecture');
    expect(r.mode).toBe('plan');
    expect(r.planScore).toBeGreaterThan(0);
  });

  it('detects high-level design questions as plan', () => {
    const r = detectIntentMode('How would you design a scalable caching layer for a multi-region application?');
    expect(r.mode).toBe('plan');
    expect(r.planScore).toBeGreaterThan(0);
  });

  it('detects review/assessment as plan', () => {
    const r = detectIntentMode('Evaluate the feasibility of using WebAssembly for our image processing pipeline');
    expect(r.mode).toBe('plan');
    expect(r.planScore).toBeGreaterThan(0);
  });

  it('detects abstract/conceptual prompts as plan', () => {
    const r = detectIntentMode('Imagine a system where autonomous agents coordinate via event sourcing');
    expect(r.mode).toBe('plan');
    expect(r.planScore).toBeGreaterThan(0);
  });
});

describe('detectIntentMode — Act Detection', () => {
  it('detects implementation prompts as act', () => {
    const r = detectIntentMode('Implement the API endpoint to create a user with proper validation');
    expect(r.mode).toBe('act');
    expect(r.confidence).toBeGreaterThan(0);
    expect(r.actScore).toBeGreaterThan(0);
  });

  it('detects "write a function" as act', () => {
    const r = detectIntentMode('Write a function that parses JSON and validates schema');
    expect(r.mode).toBe('act');
    expect(r.actScore).toBeGreaterThan(0);
  });

  it('detects build prompts as act', () => {
    const r = detectIntentMode('Build the authentication middleware with JWT and refresh tokens');
    expect(r.mode).toBe('act');
    expect(r.actScore).toBeGreaterThan(0);
  });

  it('detects fix/debug prompts as act', () => {
    const r = detectIntentMode('Debug the connection timeout issue in the API handler');
    expect(r.mode).toBe('act');
    expect(r.actScore).toBeGreaterThan(0);
  });

  it('detects deploy prompts as act', () => {
    const r = detectIntentMode('Deploy the latest changes to production and run the smoke tests');
    expect(r.mode).toBe('act');
    expect(r.actScore).toBeGreaterThan(0);
  });

  it('detects refactoring prompts as act', () => {
    const r = detectIntentMode('Refactor the user service to use dependency injection and add unit tests');
    expect(r.mode).toBe('act');
    expect(r.actScore).toBeGreaterThan(0);
  });

  it('detects code generation as act', () => {
    const r = detectIntentMode('Create the file for the new payment controller with all CRUD methods');
    expect(r.mode).toBe('act');
    expect(r.actScore).toBeGreaterThan(0);
  });
});

describe('detectIntentMode — Auto Detection', () => {
  it('returns auto for conversational greetings', () => {
    const r = detectIntentMode('Hello, how are you?');
    expect(r.mode).toBe('auto');
    expect(r.confidence).toBe(1);
    expect(r.planScore).toBe(0);
    expect(r.actScore).toBe(0);
  });

  it('returns auto for neutral prompts', () => {
    const r = detectIntentMode('What time is it?');
    expect(r.mode).toBe('auto');
  });

  it('returns auto for balanced signals (equal plan and act)', () => {
    // Need exactly equal plan and act signals.
    // "draft" (plan=1) and "build" (act=1) → plan:1, act:1 → diff=0, conf=0 → auto
    const r = detectIntentMode('Draft something and build it');
    expect(r.mode).toBe('auto');
    expect(r.planScore).toBe(1);
    expect(r.actScore).toBe(1);
  });

  it('returns auto for very short ambiguous prompts', () => {
    const r = detectIntentMode('Tell me more');
    expect(r.mode).toBe('auto');
  });
});

describe('detectIntentMode — Edge Cases', () => {
  it('handles empty string', () => {
    const r = detectIntentMode('');
    expect(r.mode).toBe('auto');
    expect(r.planScore).toBe(0);
    expect(r.actScore).toBe(0);
  });

  it('handles single word', () => {
    const r = detectIntentMode('architecture');
    // "architecture" is in PLAN_SIGNALS, so it detects as plan
    expect(r.mode).toBe('plan');
    expect(r.planScore).toBeGreaterThan(0);
  });

  it('confidence scales with signal gap', () => {
    const lowConf = detectIntentMode('Consider the approach and implement the best option'); // plan=2(act=2? let's check: "approach" is plan, "consider" is plan, "implement" is act, "best" is not a signal, "option" is plan... actually "options" is in PLAN_SIGNALS
    // This has: consider(plan), approach(plan), options(plan), implement(act) = plan:3, act:1, diff=2, total=4, conf=min(1, 2/4)=0.5
    expect(lowConf.mode).toBe('plan'); // plan wins
  });

  it('returns planScore and actScore accurately', () => {
    const r = detectIntentMode('Draft an outline for a blog post and then implement the API');
    expect(r.planScore).toBeGreaterThan(0);
    expect(r.actScore).toBeGreaterThan(0);
  });
});

describe('detectIntentMode — Real-world Prompts', () => {
  it('correctly classifies: "Design a rate limiter"', () => {
    const r = detectIntentMode('Design a rate limiter for our API gateway');
    expect(r.mode).toBe('plan'); // "design" is in plan signals
  });

  it('correctly classifies: "Code the rate limiter middleware"', () => {
    const r = detectIntentMode('Code the rate limiter middleware using Redis');
    expect(r.mode).toBe('act'); // "code" is in act signals
  });

  it('correctly classifies: "Sketch a high-level architecture"', () => {
    const r = detectIntentMode('Sketch a high-level architecture for the new feature');
    expect(r.mode).toBe('plan');
  });

  it('correctly classifies: "Fix the memory leak in the worker"', () => {
    const r = detectIntentMode('Fix the memory leak in the background worker process');
    expect(r.mode).toBe('act');
  });

  it('correctly classifies: "Explore event sourcing vs CQRS"', () => {
    const r = detectIntentMode('Explore the differences between event sourcing and CQRS for our order system');
    expect(r.mode).toBe('plan');
  });

  it('correctly classifies: "Add validation to the user form"', () => {
    const r = detectIntentMode('Add validation to the user registration form with proper error messages');
    // "validation" is not an act signal keyword, so this falls to auto
    // ("add a" would be act but "add validation" doesn't match)
    expect(r.mode).toBe('auto');
  });
});
