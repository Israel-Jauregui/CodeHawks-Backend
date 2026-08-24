import { describe, expect, it } from 'vitest';
import {
  imageUploadFinalizeSchema,
  imageUploadSchema,
  createNewsletterSchema,
  memberProfilePatchSchema,
  newsletterDeliveryReconciliationSchema,
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

  it('accepts only server-issued version-four image upload identifiers', () => {
    expect(
      imageUploadFinalizeSchema.parse({
        uploadId: '12345678-1234-4123-8123-123456789abc.webp',
      }),
    ).toEqual({ uploadId: '12345678-1234-4123-8123-123456789abc.webp' });
    for (const uploadId of [
      '../other/image.webp',
      '12345678-1234-1123-8123-123456789abc.webp',
      '12345678-1234-4123-8123-123456789abc.svg',
    ]) {
      expect(() => imageUploadFinalizeSchema.parse({ uploadId })).toThrow();
    }
  });

  it('allows only provider-owned HTTPS profile links', () => {
    expect(() => memberProfilePatchSchema.parse({ linkedinUrl: 'javascript:alert(1)' })).toThrow();
    expect(() =>
      memberProfilePatchSchema.parse({ githubUrl: 'https://github.com.evil.example/codehawk' }),
    ).toThrow('GitHub URL must use the github.com domain');
    expect(() =>
      memberProfilePatchSchema.parse({ linkedinUrl: 'https://linkedin.com@evil.example/in/member' }),
    ).toThrow('LinkedIn URL must use the linkedin.com domain');
    expect(memberProfilePatchSchema.parse({ githubUrl: 'https://github.com/codehawk' })).toEqual({
      githubUrl: 'https://github.com/codehawk',
    });
    expect(
      memberProfilePatchSchema.parse({ linkedinUrl: 'https://www.linkedin.com/in/codehawk' }),
    ).toEqual({ linkedinUrl: 'https://www.linkedin.com/in/codehawk' });
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

  it('normalizes a safe handle and rejects ambiguous or unsafe handles', () => {
    expect(memberProfilePatchSchema.parse({ handle: 'Code-Hawk_26' })).toEqual({
      handle: 'code-hawk_26',
    });
    for (const handle of ['ab', '-starts-wrong', 'ends-wrong-', 'space name', 'a.b']) {
      expect(() => memberProfilePatchSchema.parse({ handle })).toThrow();
    }
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

  it('requires a reason and explicit possible-duplicate acknowledgement for retries', () => {
    expect(() =>
      newsletterDeliveryReconciliationSchema.parse({
        reason: 'SES outcome could not be confirmed.',
        resolution: 'retry',
      }),
    ).toThrow('Retry requires acknowledgePossibleDuplicate=true');
    expect(
      newsletterDeliveryReconciliationSchema.parse({
        acknowledgePossibleDuplicate: true,
        reason: 'SES outcome could not be confirmed.',
        resolution: 'retry',
      }),
    ).toMatchObject({ acknowledgePossibleDuplicate: true, resolution: 'retry' });
  });
});
