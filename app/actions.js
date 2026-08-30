'use server';

import { revalidatePath } from 'next/cache';
import { approveComms } from '../lib/db.js';
import { renderAll } from '../lib/render.js';

export async function approveMessage(formData) {
  const ticketId = String(formData.get('ticket_id') || '').trim();
  const approver = String(formData.get('approved_by') || '').trim();
  if (!ticketId || !approver) return;

  approveComms(ticketId, approver, new Date().toISOString());
  renderAll();

  revalidatePath('/approvals');
  revalidatePath('/');
  revalidatePath('/audit');
}
