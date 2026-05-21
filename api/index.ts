import { handle } from 'hono/vercel';
import { app } from '../src/app';

export const maxDuration = 60;
export default handle(app);
