import { describe, expect, it } from 'vitest';
import {
  imageUploadSchema,
  createNewsletterSchema,
  memberProfilePatchSchema,
} from '../src/domain/schemas.js';

describe('request schemas', () => {
  it('accepts supported avatar metadata within the size limit', () => {
    expect(
      imageUploadSchema.parse({ contentType: 'image/png', fileSize: 5 * 1024 * 1024 }),
    ).toEqual({ contentType: 'image/png', fileSize: 5 * 1024 * 1024 });
  });

  it('rejects oversized avatars and unsupported types', () => {
    expect(() =>
      imageUploadSchema.parse({ contentType: 'image/gif', fileSize: 5 * 1024 * 1024 + 1 }),
    ).toThrow();
  });

  it('allows only HTTPS profile links', () => {
    expect(() => memberProfilePatchSchema.parse({ linkedinUrl: 'javascript:alert(1)' })).toThrow();
    expect(() => memberProfilePatchSchema.parse({ avatarUrl: 'http://example.test/me.png' })).toThrow(
      'URL must use HTTPS',
    );
  });

  it('keeps the optional member tech stack low-friction and removes duplicates', () => {
    expect(
      memberProfilePatchSchema.parse({
        techStack: ['TypeScript', ' typescript ', 'AWS', 'React'],
      }),
    ).toEqual({ techStack: ['TypeScript', 'AWS', 'React'] });
  });

  it('caps member tech stacks at 25 entries', () => {
    expect(() =>
      memberProfilePatchSchema.parse({
        techStack: Array.from({ length: 26 }, (_, index) => `Technology ${index}`),
      }),
    ).toThrow();
  });

  it('rejects multiline newsletter subjects that could become unsafe headers', () => {
    expect(() =>
      createNewsletterSchema.parse({
        body: 'Hello club',
        idempotencyKey: '33333333-3333-4333-8333-333333333333',
        subject: 'Hello\nBcc: target@example.test',
      }),
    ).toThrow('Subject must be one line');
  });
});
