import { handle } from 'hono/vercel';
import { app } from '../dist/app.js';

export const config = { runtime: 'nodejs', maxDuration: 60 };
export default handle(app);
