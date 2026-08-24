import { z } from 'zod';
import { CLUB_ROLES } from './entities.js';
import { isAllowedProfileUrl } from './profile-links.js';

const httpsUrl = z
  .string()
  .url()
  .max(2048)
  .refine((value) => new URL(value).protocol === 'https:', 'URL must use HTTPS.');
const optionalUrl = httpsUrl.optional();
const optionalGithubUrl = httpsUrl
  .refine(
    (value) => isAllowedProfileUrl(value, 'github'),
    'GitHub URL must use the github.com domain.',
  )
  .optional();
const optionalLinkedinUrl = httpsUrl
  .refine(
    (value) => isAllowedProfileUrl(value, 'linkedin'),
    'LinkedIn URL must use the linkedin.com domain.',
  )
  .optional();
export const memberHandleSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(40)
  .regex(
    /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])$/,
    'Handle must start and end with a letter or number and use only letters, numbers, underscores, or hyphens.',
  );
const memberTechStack = z
  .array(z.string().trim().min(1).max(50))
  .max(25)
  .transform((items) => {
    const seen = new Set<string>();
    return items.filter((item) => {
      const normalized = item.toLowerCase();
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
  });

export const memberProfilePatchSchema = z
  .object({
    avatarUrl: optionalUrl.nullable(),
    bio: z.string().trim().max(800).nullable().optional(),
    displayName: z.string().trim().min(1).max(100).optional(),
    githubUrl: optionalGithubUrl.nullable(),
    linkedinUrl: optionalLinkedinUrl.nullable(),
    major: z.string().trim().max(120).nullable().optional(),
    handle: memberHandleSchema.optional(),
    isPublicProfile: z.boolean().optional(),
    minors: z.array(z.string().trim().min(1).max(120)).max(4).optional(),
    newsletterOptIn: z.boolean().optional(),
    techStack: memberTechStack.optional(),
  })
  .strict();

export const imageUploadSchema = z
  .object({
    contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
    fileSize: z.number().int().positive().max(5 * 1024 * 1024),
  })
  .strict();

export const imageUploadFinalizeSchema = z
  .object({
    uploadId: z
      .string()
      .regex(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:jpg|png|webp)$/,
        'uploadId must be an image upload identifier issued by the CodeHawks media service.',
      ),
  })
  .strict();

export const avatarUploadSchema = imageUploadSchema;

export const memberAdministrationSchema = z
  .object({
    role: z.enum(CLUB_ROLES).optional(),
    status: z.enum(['active', 'suspended']).optional(),
  })
  .strict()
  .refine((input) => input.role !== undefined || input.status !== undefined, {
    message: 'At least one of role or status is required.',
  });

export const createProjectSchema = z
  .object({
    demoUrl: optionalUrl,
    description: z.string().trim().min(1).max(4000),
    imageUrl: optionalUrl,
    name: z.string().trim().min(1).max(100),
    repoUrl: optionalUrl,
    submitForReview: z.boolean().default(false),
    techStack: z.array(z.string().trim().min(1).max(50)).max(15).default([]),
  })
  .strict();

export const projectStatusSchema = z.enum(['draft', 'pending_review', 'published', 'archived']);

export const updateProjectSchema = createProjectSchema
  .omit({ submitForReview: true })
  .partial()
  .extend({ status: projectStatusSchema.optional() })
  .strict();

export const createTeamSchema = z
  .object({
    category: z.enum(['hackathon', 'ctf', 'project', 'study_group', 'other']),
    description: z.string().trim().min(1).max(3000),
    eventId: z.string().uuid().optional(),
    imageUrl: optionalUrl,
    joinPolicy: z.enum(['open', 'approval_required']).default('approval_required'),
    maxMembers: z.number().int().min(2).max(100),
    name: z.string().trim().min(1).max(100),
  })
  .strict();

export const teamStatusSchema = z.enum(['open', 'closed', 'archived']);

export const updateTeamSchema = createTeamSchema
  .partial()
  .extend({ status: teamStatusSchema.optional() })
  .strict();

export const createEventSchema = z
  .object({
    description: z.string().trim().min(1).max(5000),
    endsAt: z.string().datetime({ offset: true }),
    imageUrl: optionalUrl,
    location: z.string().trim().min(1).max(300),
    name: z.string().trim().min(1).max(140),
    published: z.boolean().default(false),
    startsAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .refine((input) => Date.parse(input.endsAt) > Date.parse(input.startsAt), {
    message: 'endsAt must be later than startsAt.',
    path: ['endsAt'],
  });

export const updateEventSchema = z
  .object({
    description: z.string().trim().min(1).max(5000).optional(),
    endsAt: z.string().datetime({ offset: true }).optional(),
    imageUrl: optionalUrl.nullable(),
    location: z.string().trim().min(1).max(300).optional(),
    name: z.string().trim().min(1).max(140).optional(),
    published: z.boolean().optional(),
    startsAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export const reviewJoinRequestSchema = z
  .object({ status: z.enum(['active', 'rejected']) })
  .strict();

export const inviteMemberSchema = z.object({ memberId: z.string().uuid() }).strict();

export const respondToInvitationSchema = z
  .object({ response: z.enum(['accepted', 'declined']) })
  .strict();

export const notificationReadSchema = z.object({ read: z.boolean() }).strict();

export const transferOwnershipSchema = z.object({ memberId: z.string().uuid() }).strict();

export const membershipStatusSchema = z.enum([
  'invited',
  'requested',
  'active',
  'rejected',
  'removed',
]);

export const rsvpSchema = z
  .object({ status: z.enum(['going', 'maybe']) })
  .strict();

export const createNewsletterSchema = z
  .object({
    body: z.string().trim().min(1).max(50_000),
    idempotencyKey: z.string().uuid(),
    subject: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .refine((value) => !value.includes('\r') && !value.includes('\n'), 'Subject must be one line.'),
  })
  .strict();

export const newsletterDeliveryReconciliationSchema = z
  .object({
    acknowledgePossibleDuplicate: z.boolean().optional(),
    reason: z.string().trim().min(5).max(500),
    resolution: z.enum(['mark_sent', 'mark_skipped', 'retry']),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.resolution === 'retry' && input.acknowledgePossibleDuplicate !== true) {
      context.addIssue({
        code: 'custom',
        message: 'Retry requires acknowledgePossibleDuplicate=true.',
        path: ['acknowledgePossibleDuplicate'],
      });
    }
  });
