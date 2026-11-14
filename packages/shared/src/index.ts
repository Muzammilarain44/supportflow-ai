import { z } from 'zod';

export const slugSchema = z
  .string()
  .min(3, 'Slug must be at least 3 characters')
  .max(63, 'Slug must be at most 63 characters')
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lowercase letters, numbers and hyphens only');

export const createWorkspaceSchema = z.object({
  name: z.string().trim().min(2, 'Workspace name is required').max(100),
  slug: slugSchema,
  description: z.string().trim().max(500).optional().nullable(),
});
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;

export const signupSchema = z.object({
  email: z.string().email('Enter a valid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});
export type SignupInput = z.infer<typeof signupSchema>;

export const loginSchema = signupSchema;
export type LoginInput = z.infer<typeof loginSchema>;

export const resetPasswordSchema = z.object({
  email: z.string().email('Enter a valid email address'),
});
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export type WorkspaceRole = 'owner' | 'admin' | 'member';
export interface Workspace {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  owner_id: string;
  created_at: string;
  updated_at: string;
}
export interface WorkspaceMember {
  id: string;
  workspace_id: string;
  user_id: string;
  role: WorkspaceRole;
  created_at: string;
  updated_at: string;
}
export interface ApiErrorBody { error: string; details?: unknown }
