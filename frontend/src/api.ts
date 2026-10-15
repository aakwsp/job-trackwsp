import { invoke } from '@tauri-apps/api/core'
import type { Application, Job, SyncCounts } from './types'

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
