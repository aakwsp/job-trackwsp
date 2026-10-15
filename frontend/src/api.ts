import { invoke } from '@tauri-apps/api/core'
import type { Job, SyncCounts } from './types'

// Thin typed wrappers around the Tauri commands registered in
// src-tauri/src/lib.rs. Argument keys are camelCase here: Tauri converts
// `jobId` to the Rust parameter `job_id` for you.
//
// A Rust `Err(...)` rejects the promise with the error's Display string.

export const listJobs = () => invoke<Job[]>('list_jobs')

export const setApplied = (jobId: number, applied: boolean) =>
  invoke<void>('set_applied', { jobId, applied })

export const openPosting = (url: string) => invoke<void>('open_posting', { url })

export const syncNow = () => invoke<SyncCounts>('sync_now')
