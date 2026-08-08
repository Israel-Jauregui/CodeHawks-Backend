import type { S3Client } from '@aws-sdk/client-s3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { S3MediaService } from '../src/media/s3-media-service.js';

const { createPresignedPost } = vi.hoisted(() => ({
  createPresignedPost: vi.fn(),
}));

vi.mock('@aws-sdk/s3-presigned-post', () => ({ createPresignedPost }));

describe('S3MediaService', () => {
  beforeEach(() => {
    createPresignedPost.mockReset();
    createPresignedPost.mockResolvedValue({
      fields: { policy: 'signed-policy' },
      url: 'https://media-bucket.s3.amazonaws.com',
    });
  });

  it.each([
    ['project', 'projects'],
    ['team', 'teams'],
  ] as const)('creates a constrained %s image upload under its resource prefix', async (resourceType, folder) => {
    const service = new S3MediaService(
      'media-bucket',
      'https://media.example.test',
      {} as S3Client,
    );

    const result = await service.createResourceImageUpload(
      resourceType,
      '22222222-2222-4222-8222-222222222222',
      { contentType: 'image/webp', fileSize: 2048 },
    );

    expect(createPresignedPost).toHaveBeenCalledOnce();
    const call = createPresignedPost.mock.calls[0] as unknown as [
      S3Client,
      {
        Bucket: string;
        Conditions: Array<Array<string | number>>;
        Expires: number;
        Fields: Record<string, string>;
        Key: string;
      },
    ];
    const options = call[1];
    expect(options.Bucket).toBe('media-bucket');
    expect(options.Expires).toBe(300);
    expect(options.Conditions).toContainEqual(['content-length-range', 1, 5 * 1024 * 1024]);
    expect(options.Conditions).toContainEqual(['eq', '$Content-Type', 'image/webp']);
    expect(options.Fields['Content-Type']).toBe('image/webp');
    expect(options.Key).toMatch(
      new RegExp(`^${folder}/22222222-2222-4222-8222-222222222222/[0-9a-f-]+\\.webp$`),
    );
    expect(options.Fields.key).toBe(options.Key);
    expect(result.publicUrl).toMatch(
      new RegExp(`^https://media\\.example\\.test/${folder}/22222222-2222-4222-8222-222222222222/[0-9a-f-]+\\.webp$`),
    );
  });
});
