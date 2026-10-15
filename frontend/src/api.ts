import { invoke } from '@tauri-apps/api/core'
import type {
  Application,
  IgnoredRow,
  InboxDetail,
  InboxJob,
  InboxRow,
  Job,
  MailStatus,
  RouteEdit,
  SyncCounts,
  TimelineNode,
} from './types'

// Thin typed wrappers around the Tauri commands registered in
// src-tauri/src/lib.rs. Argument keys are camelCase here: Tauri converts
// `jobId` to the Rust parameter `job_id` for you.
//
// A Rust `Err(...)` rejects the promise with the error's Display string.

export const listJobs = () => invoke<Job[]>('list_jobs')

export const setApplied = (jobId: number, applied: boolean) =>
  invoke<void>('set_applied', { jobId, applied })

export const saveNotes = (jobId: number, body: string) => invoke<void>('save_notes', { jobId, body })

export const openPosting = (url: string) => invoke<void>('open_posting', { url })

export const syncNow = () => invoke<SyncCounts>('sync_now')

export const listApplications = () => invoke<Application[]>('list_applications')

// The three pipeline moves each return the application as it now stands.
export const advanceStage = (id: number) => invoke<Application>('advance_stage', { id })

export const markRejected = (id: number) => invoke<Application>('mark_rejected', { id })

export const undoEvent = (id: number) => invoke<Application>('undo_event', { id })

export const addApplication = (company: string, title: string, appliedOn: string | null) =>
  invoke<Application>('add_application', { company, title, appliedOn })

export const saveApplicationNotes = (id: number, body: string) =>
  invoke<void>('save_application_notes', { id, body })

// Gmail (JT-13). `gmailConnect` resolves once the browser sign-in finishes
// (or rejects: timed out, denied, no keyring, ...), with the address.
export const gmailConnect = () => invoke<string>('gmail_connect')

// Stops a connect that's waiting for the browser; its promise then rejects
// with "cancelled".
export const gmailCancel = () => invoke<void>('gmail_cancel')

export const gmailStatus = () => invoke<string | null>('gmail_status')

export const gmailDisconnect = () => invoke<void>('gmail_disconnect')

// Mail polling (JT-14). Polls also run on their own (app start, every 10
// minutes); each one emits a `mail-polled` event with the new status.
export const mailStatus = () => invoke<MailStatus>('mail_status')

// [ check mail ]: polls now (or waits on nothing if one is running) and
// resolves with the status afterwards.
export const mailCheck = () => invoke<MailStatus>('mail_check')

// The Gemini API key (JT-15), stored by Rust in the OS keyring. It only
// comes back to the frontend on an explicit [ view key ].
export const llmSaveKey = (key: string) => invoke<void>('llm_save_key', { key })

export const llmGetKey = () => invoke<string | null>('llm_get_key')

// ── INBOX (JT-18) ────────────────────────────────────────────────────────
// Lists and detail come from Rust; every action is a routing command
// (JT-16), so React never decides anything about the pipeline itself.
export const inboxList = () => invoke<InboxRow[]>('inbox_list')
export const inboxIgnored = () => invoke<IgnoredRow[]>('inbox_ignored')
export const inboxDetail = (emailId: number) => invoke<InboxDetail | null>('inbox_detail', { emailId })
export const inboxSetRead = (emailId: number, read: boolean) => invoke<void>('inbox_set_read', { emailId, read })
export const inboxOpenInGmail = (emailId: number) => invoke<void>('inbox_open_in_gmail', { emailId })

export const routeConfirm = (emailId: number, applicationId: number | null, createFromJob: number | null) =>
  invoke<void>('route_confirm', { emailId, applicationId, createFromJob })
export const routeReject = (emailId: number) => invoke<void>('route_reject', { emailId })
export const routeEdit = (emailId: number, edit: RouteEdit) => invoke<unknown>('route_edit', { emailId, edit })
export const routeUndo = (emailId: number) => invoke<void>('route_undo', { emailId })
// [ not ignored ]: re-fetches the email from Gmail and re-parses it.
export const mailRestore = (gmailId: string) => invoke<void>('mail_restore', { gmailId })
export const inboxJobs = () => invoke<InboxJob[]>('inbox_jobs')
export const appEmails = (applicationId: number) => invoke<TimelineNode[]>('app_emails', { applicationId })
