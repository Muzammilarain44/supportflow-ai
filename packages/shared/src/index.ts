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

// ============================================================================
// Phase 2 — support platform
// ============================================================================

export const priorityEnum = z.enum(['low', 'medium', 'high', 'urgent']);
export type Priority = z.infer<typeof priorityEnum>;

export const conversationStatusEnum = z.enum(['open', 'pending', 'resolved', 'closed']);
export type ConversationStatus = z.infer<typeof conversationStatusEnum>;

export const ticketStatusEnum = z.enum([
  'open',
  'in_progress',
  'waiting_for_customer',
  'resolved',
  'closed',
]);
export type TicketStatus = z.infer<typeof ticketStatusEnum>;

export const ticketCategoryEnum = z.enum([
  'general',
  'billing',
  'technical',
  'feature',
  'bug',
  'other',
]);
export type TicketCategory = z.infer<typeof ticketCategoryEnum>;

export const senderTypeEnum = z.enum(['customer', 'agent', 'system']);
export type SenderType = z.infer<typeof senderTypeEnum>;

// ---------- Customers ----------
const customerFields = {
  full_name: z.string().trim().min(2, 'Full name must be at least 2 characters').max(100),
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  phone: z.string().trim().max(30).optional().nullable(),
  tags: z.array(z.string().trim().max(30)).max(20, 'At most 20 tags').optional(),
  notes: z.string().max(2000).optional().nullable(),
};

export const customerSchema = z.object({
  ...customerFields,
  tags: z.array(z.string().trim().max(30)).max(20, 'At most 20 tags').optional().default([]),
});
export type CustomerInput = z.infer<typeof customerSchema>;

export const createCustomerSchema = customerSchema;
export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;

export const updateCustomerSchema = z.object(customerFields).partial();
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;

// ---------- Conversations ----------
export const createConversationSchema = z.object({
  customer_id: z.string().uuid('customer_id must be a valid UUID'),
  priority: priorityEnum.optional(),
  tags: z.array(z.string().trim().max(30)).max(20, 'At most 20 tags').optional().default([]),
});
export type CreateConversationInput = z.infer<typeof createConversationSchema>;

export const updateConversationSchema = z.object({
  status: conversationStatusEnum.optional(),
  priority: priorityEnum.optional(),
  assigned_to: z.string().uuid('assigned_to must be a valid UUID').nullable().optional(),
  tags: z.array(z.string().trim().max(30)).max(20, 'At most 20 tags').optional(),
});
export type UpdateConversationInput = z.infer<typeof updateConversationSchema>;

// ---------- Messages ----------
export const sendMessageSchema = z.object({
  body: z.string().trim().min(1, 'Message body is required').max(5000),
  client_message_id: z.string().max(100).optional(),
});
export type SendMessageInput = z.infer<typeof sendMessageSchema>;

// ---------- Tickets ----------
export const createTicketSchema = z
  .object({
    subject: z.string().trim().min(2, 'Subject must be at least 2 characters').max(200),
    description: z.string().max(5000).optional().nullable(),
    category: ticketCategoryEnum.optional().default('general'),
    priority: priorityEnum.optional().default('medium'),
    customer_id: z.string().uuid('customer_id must be a valid UUID').optional(),
    conversation_id: z.string().uuid('conversation_id must be a valid UUID').optional(),
  })
  .strict();
export type CreateTicketInput = z.infer<typeof createTicketSchema>;

export const updateTicketSchema = z.object({
  subject: z.string().trim().min(2, 'Subject must be at least 2 characters').max(200).optional(),
  description: z.string().max(5000).optional().nullable(),
  category: ticketCategoryEnum.optional(),
  priority: priorityEnum.optional(),
  status: ticketStatusEnum.optional(),
  assigned_to: z.string().uuid('assigned_to must be a valid UUID').nullable().optional(),
});
export type UpdateTicketInput = z.infer<typeof updateTicketSchema>;

export const addTicketNoteSchema = z.object({
  body: z.string().trim().min(1, 'Note body is required').max(5000),
});
export type AddTicketNoteInput = z.infer<typeof addTicketNoteSchema>;

export const addConversationNoteSchema = z.object({
  body: z.string().trim().min(1, 'Note body is required').max(5000),
});
export type AddConversationNoteInput = z.infer<typeof addConversationNoteSchema>;

// ---------- Widget (public) ----------
export const widgetSessionSchema = z.object({
  name: z.string().trim().max(100).optional(),
  email: z.string().trim().email('Enter a valid email address').optional(),
});
export type WidgetSessionInput = z.infer<typeof widgetSessionSchema>;

export const widgetMessageSchema = z.object({
  body: z.string().trim().min(1, 'Message body is required').max(5000),
  // Idempotency key supplied by the widget embed (one per send). A repeat
  // with the same key in the same conversation returns the existing message
  // (HTTP 200) instead of storing a duplicate — see 0005 migration.
  client_message_id: z.string().trim().max(100).optional(),
});
export type WidgetMessageInput = z.infer<typeof widgetMessageSchema>;

// ---------- List / pagination query ----------
export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1, 'page must be at least 1').default(1),
  pageSize: z.coerce.number().int().min(1, 'pageSize must be at least 1').max(100, 'pageSize must be at most 100').default(20),
  search: z.string().trim().max(100).optional(),
  status: z.string().trim().max(50).optional(),
  priority: z.string().trim().max(50).optional(),
  assignedTo: z.string().trim().max(100).optional(),
  sort: z.string().trim().max(50).optional(),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

// ---------- Phase 2 types ----------
export interface Customer {
  id: string;
  workspace_id: string;
  full_name: string;
  email: string;
  phone: string | null;
  tags: string[];
  notes: string | null;
  created_at: string;
  updated_at: string;
  last_activity_at: string | null;
}

export interface Conversation {
  id: string;
  workspace_id: string;
  customer_id: string;
  status: ConversationStatus;
  priority: Priority;
  assigned_to: string | null;
  tags: string[];
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
  /** Joined customer (list/detail enrichment). */
  customer?: { id: string; full_name: string; email: string };
  /** Preview of the most recent message (list enrichment). */
  last_message?: { body: string; created_at: string } | null;
  /** Count of unread customer messages (list enrichment). */
  unread_count?: number;
}

export interface Message {
  id: string;
  workspace_id: string;
  conversation_id: string;
  customer_id: string | null;
  sender_type: SenderType;
  sender_id: string | null;
  body: string;
  client_message_id: string | null;
  created_at: string;
  read_at: string | null;
}

export interface Ticket {
  id: string;
  workspace_id: string;
  customer_id: string | null;
  conversation_id: string | null;
  subject: string;
  description: string | null;
  category: TicketCategory;
  priority: Priority;
  status: TicketStatus;
  assigned_to: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

export interface TicketEvent {
  id: string;
  workspace_id: string;
  ticket_id: string;
  actor_id: string | null;
  event_type:
    | 'created'
    | 'status_changed'
    | 'priority_changed'
    | 'assigned'
    | 'unassigned'
    | 'note_added'
    | 'comment_added'
    | 'resolved'
    | 'reopened'
    | 'updated';
  field_name: string | null;
  old_value: string | null;
  new_value: string | null;
  note: string | null;
  created_at: string;
}

export interface ConversationNote {
  id: string;
  workspace_id: string;
  conversation_id: string;
  author_id: string | null;
  body: string;
  created_at: string;
  updated_at: string;
}

export interface WidgetConfig {
  business_name: string;
  welcome_message: string;
  primary_color: string;
  enabled: boolean;
}

// ---------- Widget settings (admin, Phase 2 frontend) ----------
export interface WidgetSettings {
  id: string;
  workspace_id: string;
  public_key: string;
  enabled: boolean;
  business_name: string;
  welcome_message: string;
  primary_color: string;
  allowed_origins: string[];
  created_at: string;
  updated_at: string;
}

const widgetSettingsFields = {
  business_name: z.string().trim().min(1, 'Business name is required').max(100),
  welcome_message: z.string().trim().min(1, 'Welcome message is required').max(500),
  primary_color: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Primary color must be a hex color like #7C3AED'),
  enabled: z.boolean(),
  allowed_origins: z.array(z.string().trim().max(200)).max(20, 'At most 20 origins'),
};

export const createWidgetSettingsSchema = z.object(widgetSettingsFields).partial();
export type CreateWidgetSettingsInput = z.infer<typeof createWidgetSettingsSchema>;

export const updateWidgetSettingsSchema = z.object(widgetSettingsFields).partial().strict();
export type UpdateWidgetSettingsInput = z.infer<typeof updateWidgetSettingsSchema>;

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

// ============================================================================
// Phase 2.1 — profiles (Issue 2: real member names instead of UUIDs)
// ============================================================================

/** One profile row per auth user. Never carries an email address. */
export interface Profile {
  id: string;
  display_name: string | null;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}

/** A workspace member enriched with profile display info (server-side). */
export interface MemberWithProfile extends WorkspaceMember {
  /** Display name, or 'Unnamed member' when the user has no profile/name. */
  display_name: string;
  avatar_url: string | null;
  /** Server-computed initials from display_name ('?' when unnamed). */
  initials: string;
  /** Alias of the member row's created_at. */
  member_since: string;
}

/** Initials from a display name: first letters of the first two words. */
export function profileInitials(displayName: string | null | undefined): string {
  const parts = (displayName ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return parts.slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');
}

/** The name the UI shows when a user has no profile display name. */
export const UNNAMED_MEMBER = 'Unnamed member';

export const updateProfileSchema = z
  .object({
    display_name: z.string().trim().max(100, 'Display name must be at most 100 characters').nullable().optional(),
    avatar_url: z
      .string()
      .trim()
      .max(500, 'Avatar URL must be at most 500 characters')
      .refine((v) => v === '' || /^https:\/\//.test(v), 'avatar_url must be an https URL')
      .nullable()
      .optional(),
  })
  .strict();
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
