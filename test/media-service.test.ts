import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Member } from '../src/domain/entities.js';
import { S3MediaService } from '../src/media/s3-media-service.js';

const { createPresignedPost } = vi.hoisted(() => ({
  createPresignedPost: vi.fn(),
}));

vi.mock('@aws-sdk/s3-presigned-post', () => ({ createPresignedPost }));

const uploadId = '12345678-1234-4123-8123-123456789abc.png';

function missingObject(): Error {
  const error = new Error('missing');
  error.name = 'NotFound';
  return error;
}

function pngBytes(): Uint8Array {
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
}

describe('S3MediaService', () => {
  beforeEach(() => {
    createPresignedPost.mockReset();
    createPresignedPost.mockResolvedValue({
      fields: { policy: 'signed-policy' },
      url: 'https://media-bucket.s3.amazonaws.com',
    });
  });

  it.each([
    ['event', 'events'],
    ['project', 'projects'],
    ['team', 'teams'],
  ] as const)(
    'creates a constrained %s upload only under its non-public pending prefix',
    async (resourceType, folder) => {
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
      expect(options.Conditions).toContainEqual([
        'eq',
        '$Cache-Control',
        'private,no-store,max-age=0',
      ]);
      expect(options.Key).toMatch(
        new RegExp(
          `^pending/${folder}/22222222-2222-4222-8222-222222222222/[0-9a-f-]+\\.webp$`,
        ),
      );
      expect(options.Fields.key).toBe(options.Key);
      expect(result.uploadId).toMatch(/^[0-9a-f-]+\.webp$/);
      expect(result).not.toHaveProperty('publicUrl');
    },
  );

  it('validates an ETag-pinned pending image and conditionally creates its final URL once', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ ContentLength: 8, ContentType: 'image/png', ETag: '"etag"' })
      .mockResolvedValueOnce({
        Body: { transformToByteArray: vi.fn().mockResolvedValue(pngBytes()) },
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    const service = new S3MediaService(
      'media-bucket',
      'https://media.example.test',
      { send } as unknown as S3Client,
    );

    await expect(
      service.finalizeAvatarUpload({ id: 'member-id' } as Member, uploadId),
    ).resolves.toEqual({
      publicUrl: `https://media.example.test/avatars/member-id/${uploadId}`,
    });

    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(HeadObjectCommand);
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(GetObjectCommand);
    const finalWrite = send.mock.calls[2]?.[0] as PutObjectCommand;
    expect(finalWrite).toBeInstanceOf(PutObjectCommand);
    expect(finalWrite.input).toMatchObject({
      Bucket: 'media-bucket',
      CacheControl: 'private,no-store,max-age=0',
      ContentType: 'image/png',
      IfNoneMatch: '*',
      Key: `avatars/member-id/${uploadId}`,
    });
    const read = send.mock.calls[1]?.[0] as GetObjectCommand;
    expect(read.input.IfMatch).toBe('"etag"');
    expect(send.mock.calls[3]?.[0]).toBeInstanceOf(DeleteObjectCommand);
  });

  it('deletes invalid pending bytes without copying them to a public key', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ ContentLength: 4, ContentType: 'image/png', ETag: '"etag"' })
      .mockResolvedValueOnce({
        Body: {
          transformToByteArray: vi.fn().mockResolvedValue(Uint8Array.from([0x3c, 0x68, 0x74, 0x6d])),
        },
      })
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(missingObject());
    const service = new S3MediaService(
      'media-bucket',
      'https://media.example.test',
      { send } as unknown as S3Client,
    );

    await expect(
      service.finalizeResourceImageUpload('project', 'project-id', uploadId),
    ).resolves.toBeUndefined();
    expect(send.mock.calls[2]?.[0]).toBeInstanceOf(DeleteObjectCommand);
    expect(send.mock.calls.some(([command]) => command instanceof PutObjectCommand)).toBe(false);
  });

  it('makes finalization idempotent after the pending object has been deleted', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(missingObject())
      .mockResolvedValueOnce({ ContentLength: 8, ContentType: 'image/png', ETag: '"etag"' })
      .mockResolvedValueOnce({
        Body: { transformToByteArray: vi.fn().mockResolvedValue(pngBytes()) },
      });
    const service = new S3MediaService(
      'media-bucket',
      'https://media.example.test',
      { send } as unknown as S3Client,
    );

    await expect(
      service.finalizeResourceImageUpload('team', 'team-id', uploadId),
    ).resolves.toEqual({
      publicUrl: `https://media.example.test/teams/team-id/${uploadId}`,
    });
    expect(send.mock.calls.some(([command]) => command instanceof PutObjectCommand)).toBe(false);
  });

  it('never overwrites an immutable final key when a presigned pending upload is replayed', async () => {
    const precondition = new Error('destination already exists') as Error & {
      $metadata?: { httpStatusCode: number };
    };
    precondition.name = 'PreconditionFailed';
    precondition.$metadata = { httpStatusCode: 412 };
    const validHead = { ContentLength: 8, ContentType: 'image/png', ETag: '"etag"' };
    const validBody = {
      Body: { transformToByteArray: vi.fn().mockResolvedValue(pngBytes()) },
    };
    const send = vi
      .fn()
      .mockResolvedValueOnce(validHead)
      .mockResolvedValueOnce(validBody)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(validHead)
      .mockResolvedValueOnce(validBody)
      .mockRejectedValueOnce(precondition)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(validHead)
      .mockResolvedValueOnce(validBody);
    const service = new S3MediaService(
      'media-bucket',
      'https://media.example.test',
      { send } as unknown as S3Client,
    );

    const first = await service.finalizeResourceImageUpload('event', 'event-id', uploadId);
    const replay = await service.finalizeResourceImageUpload('event', 'event-id', uploadId);

    expect(replay).toEqual(first);
    const finalWrites = send.mock.calls.filter(
      ([command]) => command instanceof PutObjectCommand,
    );
    expect(finalWrites).toHaveLength(2);
    expect(
      finalWrites.every(
        ([command]) => (command as PutObjectCommand).input.IfNoneMatch === '*',
      ),
    ).toBe(true);
  });

  it('rejects a caller-created upload identifier before touching S3', async () => {
    const send = vi.fn();
    const service = new S3MediaService(
      'media-bucket',
      'https://media.example.test',
      { send } as unknown as S3Client,
    );

    await expect(
      service.finalizeAvatarUpload({ id: 'member-id' } as Member, '../other/image.webp'),
    ).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  it('deletes only a managed image under the expected final prefix', async () => {
    const send = vi.fn().mockResolvedValue({});
    const service = new S3MediaService(
      'media-bucket',
      'https://media.example.test',
      { send } as unknown as S3Client,
    );

    await service.deleteManagedImage(
      'https://media.example.test/avatars/member-id/current.webp',
      'avatars/member-id/',
    );
    await service.deleteManagedImage(
      'https://media.example.test/avatars/other-member/current.webp',
      'avatars/member-id/',
    );

    expect(send).toHaveBeenCalledOnce();
    const deletion = send.mock.calls[0]?.[0] as DeleteObjectCommand;
    expect(deletion.input.Key).toBe('avatars/member-id/current.webp');
  });

  it('removes final and pending avatar objects attributable to a deleted member', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Contents: [
          { Key: 'avatars/member-id/old.png' },
          { Key: 'avatars/member-id/current.webp' },
        ],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        Contents: [{ Key: `pending/avatars/member-id/${uploadId}` }],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({});
    const service = new S3MediaService(
      'media-bucket',
      'https://media.example.test',
      { send } as unknown as S3Client,
    );

    await service.deleteMemberAvatar({ id: 'member-id' } as Member);

    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(ListObjectsV2Command);
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(DeleteObjectsCommand);
    expect(send.mock.calls[2]?.[0]).toBeInstanceOf(ListObjectsV2Command);
    expect(send.mock.calls[3]?.[0]).toBeInstanceOf(DeleteObjectsCommand);
  });
});
