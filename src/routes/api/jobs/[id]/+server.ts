import { json } from '@sveltejs/kit';
import { getJob, cancelJob } from '$lib/server/jobs';
import type { RequestHandler } from './$types';

/**
 * GET /api/jobs/[id]
 * Poll a job's status and accumulated lines.
 * Returns all lines every time — client tracks its own cursor locally.
 */
export const GET: RequestHandler = async ({ params }) => {
	const job = getJob(params.id);
	if (!job) {
		return json({ error: 'Job not found' }, { status: 404 });
	}

	return json({
		id: job.id,
		status: job.status,
		lines: job.lines,
		result: job.result ?? null
	});
};

/**
 * DELETE /api/jobs/[id]
 * Request cancellation of a running job. The job's operation polls the flag
 * between units of work and stops gracefully.
 */
export const DELETE: RequestHandler = async ({ params }) => {
	const cancelled = cancelJob(params.id);
	return json({ cancelled });
};
