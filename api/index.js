import { handle } from 'hono/vercel';
import { app } from './bundle.js';

export const maxDuration = 60;
export default handle(app);
