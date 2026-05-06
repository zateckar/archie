import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';

export async function GET() {
    let dbOk = false;
    try {
        db.prepare('SELECT 1').get();
        dbOk = true;
    } catch {
        dbOk = false;
    }
    return json({ status: dbOk ? 'ok' : 'degraded', db: dbOk });
}