import { supabase } from './supabase';

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:4000';

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function apiFetch(path: string, init: RequestInit = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()), ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  return body;
}

/** Public (no-auth) fetch for the widget endpoints — no Supabase token is sent. */
export async function widgetFetch(path: string, init: RequestInit = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  return body;
}

function qs(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') search.set(k, String(v));
  }
  const s = search.toString();
  return s ? `?${s}` : '';
}

// ---------- Types (mirror @supportflow/shared; the web app has no shared dep) ----------
export type WorkspaceRole = 'owner' | 'admin' | 'member';
export interface Workspace {
  id: string; name: string; slug: string; description: string | null;
  owner_id: string; created_at: string; updated_at: string;
}
export interface WorkspaceMember {
  id: string; workspace_id: string; user_id: string; role: WorkspaceRole; created_at: string; updated_at: string;
}
// Phase 2.1 (Issue 2): profile display info for a workspace member.
export interface Profile {
  id: string; display_name: string | null; avatar_url: string | null;
  created_at: string; updated_at: string;
}
export interface MemberWithProfile extends WorkspaceMember {
  display_name: string; avatar_url: string | null; initials: string; member_since: string;
}
export type Priority = 'low' | 'medium' | 'high' | 'urgent';
export type ConversationStatus = 'open' | 'pending' | 'resolved' | 'closed';
export type TicketStatus = 'open' | 'in_progress' | 'waiting_for_customer' | 'resolved' | 'closed';
export type TicketCategory = 'general' | 'billing' | 'technical' | 'feature' | 'bug' | 'other';
export type SenderType = 'customer' | 'agent' | 'system';
export interface Customer {
  id: string; workspace_id: string; full_name: string; email: string; phone: string | null;
  tags: string[]; notes: string | null; created_at: string; updated_at: string; last_activity_at: string | null;
}
export interface Conversation {
  id: string; workspace_id: string; customer_id: string; status: ConversationStatus;
  priority: Priority; assigned_to: string | null; tags: string[]; created_at: string;
  updated_at: string; last_message_at: string | null;
  ai_paused?: boolean; handoff_reason?: string | null; handed_off_at?: string | null;
  customer?: { id: string; full_name: string; email: string } | null;
  last_message?: { body: string; created_at: string } | null;
  unread_count?: number;
}
export interface Message {
  id: string; workspace_id: string; conversation_id: string; customer_id: string | null;
  sender_type: SenderType; sender_id: string | null; body: string;
  client_message_id: string | null; created_at: string; read_at: string | null;
}
export interface Ticket {
  id: string; workspace_id: string; customer_id: string | null; conversation_id: string | null;
  subject: string; description: string | null; category: TicketCategory; priority: Priority;
  status: TicketStatus; assigned_to: string | null; created_by: string | null;
  created_at: string; updated_at: string; resolved_at: string | null;
  escalation_reason?: string | null; escalated_at?: string | null;
}
export interface TicketEvent {
  id: string; workspace_id: string; ticket_id: string; actor_id: string | null;
  event_type: string; field_name: string | null; old_value: string | null;
  new_value: string | null; note: string | null; created_at: string;
}
export interface ConversationNote {
  id: string; workspace_id: string; conversation_id: string; author_id: string | null;
  body: string; created_at: string; updated_at: string;
}
export interface WidgetConfig {
  business_name: string; welcome_message: string; primary_color: string; enabled: boolean;
}
export interface WidgetSettings extends WidgetConfig {
  id: string; workspace_id: string; public_key: string; allowed_origins: string[];
  created_at: string; updated_at: string;
}
export interface TicketStats {
  by_status: Record<TicketStatus, number>;
  by_priority: Record<Priority, number>;
  total: number;
}
export interface ListParams {
  page?: number; pageSize?: number; search?: string; status?: string;
  priority?: string; assignedTo?: string; sort?: string; tag?: string; category?: string;
}
export interface Paginated<T> { items: T[]; total: number; page: number; pageSize: number }

// ---------- Phase 3: AI / handoff types (local; packages/shared untouched) ----------
export type AiMode = 'disabled' | 'suggestion' | 'auto' | 'human_only';
export type KnowledgeKind = 'article' | 'faq';
export interface KnowledgeDocument {
  id: string; workspace_id: string; title: string; content: string; kind: KnowledgeKind;
  enabled: boolean; archived: boolean; created_by: string | null;
  created_at: string; updated_at: string;
  /** Latest indexing job status, when the API returns one — never invented. */
  latest_job_status?: string | null;
  indexing_status?: string | null;
}
export interface AiSettings {
  id?: string; workspace_id: string; enabled: boolean; mode: AiMode;
  provider_order: string[]; auto_reply_require_grounding: boolean;
  escalation_on_low_confidence: boolean; created_at?: string; updated_at?: string;
}
export interface AiOverview {
  ai_enabled: boolean; mode: AiMode;
  automation: { pending: number; processing: number; failed: number; dead: number; last_processed_at: string | null };
  totals: { assisted_conversations: number; suggestions: number; auto_replies: number; handoffs: number; failed_executions: number };
}
export type AiExecutionStatus = 'pending' | 'success' | 'failed' | 'escalated' | 'skipped';
export interface AiExecution {
  id: string; workspace_id: string; conversation_id: string; message_id: string | null;
  event_id: string | null; provider: string | null; model: string | null; mode: string | null;
  status: AiExecutionStatus; prompt_tokens: number | null; completion_tokens: number | null;
  latency_ms: number | null; error: string | null; suggestion: string | null; created_at: string;
}
export interface AutomationEvent {
  id: string; workspace_id: string; event_type: string; entity_type: string; entity_id: string;
  status: string; attempts: number; payload?: Record<string, unknown> | null;
  created_at: string; processed_at: string | null; last_error?: string | null;
}
export type AiSuggestionStatus = 'pending' | 'accepted' | 'edited' | 'rejected';
export interface AiSuggestion {
  id: string; workspace_id: string; conversation_id: string; message_id: string | null;
  suggestion: string; sources: Array<{ title?: string; id?: string } | string> | null;
  status: AiSuggestionStatus; reviewed_by: string | null; created_at: string; updated_at: string;
}
export interface HandoffResult {
  ticket: { id: string }; handoff: { id: string }; reused: boolean;
}

export const api = {
  // Workspaces (Phase 1)
  listWorkspaces: (): Promise<{ workspaces: Workspace[] }> => apiFetch('/api/workspaces'),
  createWorkspace: (payload: { name: string; slug: string; description?: string | null }): Promise<{ workspace: Workspace }> =>
    apiFetch('/api/workspaces', { method: 'POST', body: JSON.stringify(payload) }),
  getWorkspace: (id: string): Promise<{ workspace: Workspace }> => apiFetch(`/api/workspaces/${id}`),
  listMembers: (workspaceId: string): Promise<{ members: WorkspaceMember[] }> =>
    apiFetch(`/api/workspaces/${workspaceId}/members`),
  // Phase 2.1 (Issue 2): same endpoint, typed with profile display info.
  listMembersWithProfiles: (workspaceId: string): Promise<{ members: MemberWithProfile[] }> =>
    apiFetch(`/api/workspaces/${workspaceId}/members`),
  getMyProfile: (): Promise<{ profile: Profile }> => apiFetch('/api/profile/me'),
  updateMyProfile: (payload: { display_name?: string | null; avatar_url?: string | null }): Promise<{ profile: Profile }> =>
    apiFetch('/api/profile/me', { method: 'PATCH', body: JSON.stringify(payload) }),

  // Customers
  listCustomers: (workspaceId: string, params: ListParams = {}): Promise<{ customers: Customer[]; total: number; page: number; pageSize: number }> =>
    apiFetch(`/api/workspaces/${workspaceId}/customers${qs(params)}`),
  createCustomer: (workspaceId: string, payload: { full_name: string; email: string; phone?: string | null; tags?: string[]; notes?: string | null }): Promise<{ customer: Customer }> =>
    apiFetch(`/api/workspaces/${workspaceId}/customers`, { method: 'POST', body: JSON.stringify(payload) }),
  getCustomer: (workspaceId: string, id: string): Promise<{ customer: Customer; tickets: { total: number }; conversations: { total: number }; recent_conversations: Array<{ id: string; status: string; priority: string; last_message_at: string | null; created_at: string; last_message: { body: string; created_at: string } | null }>; recent_tickets: Ticket[] }> =>
    apiFetch(`/api/workspaces/${workspaceId}/customers/${id}`),
  updateCustomer: (workspaceId: string, id: string, payload: Partial<{ full_name: string; email: string; phone: string | null; tags: string[]; notes: string | null }>): Promise<{ customer: Customer }> =>
    apiFetch(`/api/workspaces/${workspaceId}/customers/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),

  // Conversations
  listConversations: (workspaceId: string, params: ListParams = {}): Promise<{ conversations: Conversation[]; total: number; page: number; pageSize: number }> =>
    apiFetch(`/api/workspaces/${workspaceId}/conversations${qs(params)}`),
  createConversation: (workspaceId: string, payload: { customer_id: string; priority?: Priority; tags?: string[] }): Promise<{ conversation: Conversation }> =>
    apiFetch(`/api/workspaces/${workspaceId}/conversations`, { method: 'POST', body: JSON.stringify(payload) }),
  getConversation: (workspaceId: string, id: string): Promise<{ conversation: Conversation; customer: Customer | null; assigned_member: WorkspaceMember | null }> =>
    apiFetch(`/api/workspaces/${workspaceId}/conversations/${id}`),
  listMessages: (workspaceId: string, conversationId: string, params: ListParams = {}): Promise<{ messages: Message[]; total: number; page: number; pageSize: number }> =>
    apiFetch(`/api/workspaces/${workspaceId}/conversations/${conversationId}/messages${qs(params)}`),
  sendMessage: (workspaceId: string, conversationId: string, payload: { body: string; client_message_id?: string }): Promise<{ message: Message }> =>
    apiFetch(`/api/workspaces/${workspaceId}/conversations/${conversationId}/messages`, { method: 'POST', body: JSON.stringify(payload) }),
  updateConversation: (workspaceId: string, id: string, payload: Partial<{ status: ConversationStatus; priority: Priority; assigned_to: string | null; tags: string[] }>): Promise<{ conversation: Conversation }> =>
    apiFetch(`/api/workspaces/${workspaceId}/conversations/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  markConversationRead: (workspaceId: string, id: string): Promise<{ read_count: number }> =>
    apiFetch(`/api/workspaces/${workspaceId}/conversations/${id}/read`, { method: 'POST', body: JSON.stringify({}) }),
  addConversationNote: (workspaceId: string, id: string, body: string): Promise<{ note: ConversationNote }> =>
    apiFetch(`/api/workspaces/${workspaceId}/conversations/${id}/notes`, { method: 'POST', body: JSON.stringify({ body }) }),
  listConversationNotes: (workspaceId: string, id: string): Promise<{ notes: ConversationNote[]; total: number; page: number; pageSize: number }> =>
    apiFetch(`/api/workspaces/${workspaceId}/conversations/${id}/notes`),

  // Tickets
  listTickets: (workspaceId: string, params: ListParams = {}): Promise<{ tickets: Ticket[]; total: number; page: number; pageSize: number }> =>
    apiFetch(`/api/workspaces/${workspaceId}/tickets${qs(params)}`),
  getTicketStats: (workspaceId: string): Promise<TicketStats> =>
    apiFetch(`/api/workspaces/${workspaceId}/tickets/stats`),
  createTicket: (workspaceId: string, payload: { subject: string; description?: string | null; category?: TicketCategory; priority?: Priority; customer_id?: string; conversation_id?: string }): Promise<{ ticket: Ticket }> =>
    apiFetch(`/api/workspaces/${workspaceId}/tickets`, { method: 'POST', body: JSON.stringify(payload) }),
  getTicket: (workspaceId: string, id: string): Promise<{ ticket: Ticket; customer: { id: string; full_name: string; email: string } | null; conversation: { id: string; status: string; priority: string; customer_id: string } | null; assigned_member: WorkspaceMember | null }> =>
    apiFetch(`/api/workspaces/${workspaceId}/tickets/${id}`),
  updateTicket: (workspaceId: string, id: string, payload: Partial<{ subject: string; description: string | null; category: TicketCategory; priority: Priority; status: TicketStatus; assigned_to: string | null }>): Promise<{ ticket: Ticket }> =>
    apiFetch(`/api/workspaces/${workspaceId}/tickets/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  listTicketEvents: (workspaceId: string, id: string): Promise<{ events: TicketEvent[]; total: number; page: number; pageSize: number }> =>
    apiFetch(`/api/workspaces/${workspaceId}/tickets/${id}/events`),
  addTicketNote: (workspaceId: string, id: string, body: string): Promise<{ event: TicketEvent }> =>
    apiFetch(`/api/workspaces/${workspaceId}/tickets/${id}/notes`, { method: 'POST', body: JSON.stringify({ body }) }),

  // Widget settings (admin)
  getWidgetSettings: async (workspaceId: string): Promise<WidgetSettings | null> => {
    try {
      const res = await apiFetch(`/api/workspaces/${workspaceId}/widget-settings`) as { widget_settings: WidgetSettings };
      return res.widget_settings;
    } catch (err) {
      if ((err as Error).message.toLowerCase().includes('not found')) return null;
      throw err;
    }
  },
  createWidgetSettings: (workspaceId: string, payload: Partial<{ business_name: string; welcome_message: string; primary_color: string; enabled: boolean; allowed_origins: string[] }>): Promise<{ widget_settings: WidgetSettings }> =>
    apiFetch(`/api/workspaces/${workspaceId}/widget-settings`, { method: 'POST', body: JSON.stringify(payload) }),
  updateWidgetSettings: (workspaceId: string, payload: Partial<{ business_name: string; welcome_message: string; primary_color: string; enabled: boolean; allowed_origins: string[] }>): Promise<{ widget_settings: WidgetSettings }> =>
    apiFetch(`/api/workspaces/${workspaceId}/widget-settings`, { method: 'PATCH', body: JSON.stringify(payload) }),

  // Public widget (no auth). Every call carries parent_origin — the origin
  // of the page embedding the iframe, read from document.referrer (see
  // WidgetEmbed.getParentOrigin). The API validates it against the
  // widget's allow-list; an omitted origin is rejected unless the
  // migration-0008 policy RPCs are not deployed yet (legacy fallback).
  getWidgetConfig: (key: string, parentOrigin?: string): Promise<WidgetConfig> =>
    widgetFetch(`/api/widget/config?key=${encodeURIComponent(key)}${parentOrigin ? `&parent_origin=${encodeURIComponent(parentOrigin)}` : ''}`),

  // ---------- Phase 3: knowledge base ----------
  listKnowledge: async (
    workspaceId: string,
    params: { q?: string; kind?: string; enabled?: boolean; page?: number; pageSize?: number } = {},
  ): Promise<{ knowledge_documents: KnowledgeDocument[]; total: number; page: number; pageSize: number }> => {
    const raw = await apiFetch(`/api/workspaces/${workspaceId}/knowledge${qs({
      q: params.q, kind: params.kind,
      enabled: params.enabled === undefined ? undefined : String(params.enabled),
      page: params.page, pageSize: params.pageSize,
    })}`) as { knowledge_documents?: KnowledgeDocument[]; items?: KnowledgeDocument[]; total: number; page: number; pageSize: number };
    return {
      knowledge_documents: raw.knowledge_documents ?? raw.items ?? [],
      total: raw.total ?? 0, page: raw.page ?? 1, pageSize: raw.pageSize ?? 20,
    };
  },
  getKnowledge: (workspaceId: string, id: string): Promise<{ knowledge_document: KnowledgeDocument }> =>
    apiFetch(`/api/workspaces/${workspaceId}/knowledge/${id}`),
  createKnowledge: (workspaceId: string, payload: { title: string; content: string; kind: KnowledgeKind }): Promise<{ knowledge_document: KnowledgeDocument }> =>
    apiFetch(`/api/workspaces/${workspaceId}/knowledge`, { method: 'POST', body: JSON.stringify(payload) }),
  updateKnowledge: (workspaceId: string, id: string, payload: Partial<{ title: string; content: string; kind: KnowledgeKind; enabled: boolean }>): Promise<{ knowledge_document: KnowledgeDocument }> =>
    apiFetch(`/api/workspaces/${workspaceId}/knowledge/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  deleteKnowledge: (workspaceId: string, id: string): Promise<{ knowledge_document: KnowledgeDocument }> =>
    apiFetch(`/api/workspaces/${workspaceId}/knowledge/${id}`, { method: 'DELETE' }),
  reindexKnowledge: (workspaceId: string, id: string): Promise<{ job: unknown }> =>
    apiFetch(`/api/workspaces/${workspaceId}/knowledge/${id}/reindex`, { method: 'POST', body: JSON.stringify({}) }),

  // ---------- Phase 3: AI settings / overview ----------
  getAiSettings: (workspaceId: string): Promise<{ ai_settings: AiSettings }> =>
    apiFetch(`/api/workspaces/${workspaceId}/ai-settings`),
  updateAiSettings: (workspaceId: string, payload: Partial<{ enabled: boolean; mode: AiMode; provider_order: string[]; auto_reply_require_grounding: boolean; escalation_on_low_confidence: boolean }>): Promise<{ ai_settings: AiSettings }> =>
    apiFetch(`/api/workspaces/${workspaceId}/ai-settings`, { method: 'PATCH', body: JSON.stringify(payload) }),
  getAiOverview: (workspaceId: string): Promise<AiOverview> =>
    apiFetch(`/api/workspaces/${workspaceId}/ai-overview`),

  // ---------- Phase 3: automation activity ----------
  listAiExecutions: (workspaceId: string, params: { status?: string; page?: number; pageSize?: number } = {}): Promise<{ ai_executions: AiExecution[]; total: number; page: number; pageSize: number }> =>
    apiFetch(`/api/workspaces/${workspaceId}/ai-executions${qs(params)}`),
  listAutomationEvents: (workspaceId: string, params: { status?: string; page?: number; pageSize?: number } = {}): Promise<{ automation_events: AutomationEvent[]; total: number; page: number; pageSize: number }> =>
    apiFetch(`/api/workspaces/${workspaceId}/automation-events${qs(params)}`),

  // ---------- Phase 3: suggestions + handoff (per conversation) ----------
  listSuggestions: (workspaceId: string, conversationId: string, params: { page?: number; pageSize?: number } = {}): Promise<{ ai_suggestions: AiSuggestion[]; total: number; page: number; pageSize: number }> =>
    apiFetch(`/api/workspaces/${workspaceId}/conversations/${conversationId}/suggestions${qs(params)}`),
  acceptSuggestion: (workspaceId: string, conversationId: string, suggestionId: string, payload: { edited_text?: string } = {}): Promise<{ ai_suggestion: AiSuggestion }> =>
    apiFetch(`/api/workspaces/${workspaceId}/conversations/${conversationId}/suggestions/${suggestionId}/accept`, { method: 'POST', body: JSON.stringify(payload) }),
  rejectSuggestion: (workspaceId: string, conversationId: string, suggestionId: string): Promise<{ ai_suggestion: AiSuggestion }> =>
    apiFetch(`/api/workspaces/${workspaceId}/conversations/${conversationId}/suggestions/${suggestionId}/reject`, { method: 'POST', body: JSON.stringify({}) }),
  handoffConversation: (workspaceId: string, conversationId: string, reason: string): Promise<HandoffResult> =>
    apiFetch(`/api/workspaces/${workspaceId}/conversations/${conversationId}/handoff`, { method: 'POST', body: JSON.stringify({ reason }) }),
  resumeAi: (workspaceId: string, conversationId: string): Promise<{ resumed: boolean }> =>
    apiFetch(`/api/workspaces/${workspaceId}/conversations/${conversationId}/ai-resume`, { method: 'POST', body: JSON.stringify({}) }),
  createWidgetSession: (payload: { key: string; name?: string; email?: string; parent_origin?: string }): Promise<{ token: string; conversation_id: string; customer_id: string; expires_at: string }> =>
    widgetFetch('/api/widget/sessions', { method: 'POST', body: JSON.stringify(payload) }),
  sendWidgetMessage: (payload: { token: string; body: string; client_message_id?: string; parent_origin?: string }): Promise<{ message_id: string }> =>
    widgetFetch('/api/widget/messages', { method: 'POST', body: JSON.stringify(payload) }),
  getWidgetHistory: (token: string, parentOrigin?: string): Promise<{ messages: Array<{ id: string; sender_type: string; body: string; created_at: string }> }> =>
    widgetFetch(`/api/widget/history?token=${encodeURIComponent(token)}${parentOrigin ? `&parent_origin=${encodeURIComponent(parentOrigin)}` : ''}`),
};
