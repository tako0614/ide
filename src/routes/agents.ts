import { Hono } from 'hono';
import { currentSession, verifiedInternalActor } from '../middleware/auth.js';
import { mcpGrantForActor } from './mcp.js';
export function agentAccess(c) {
    const browser = currentSession(c);
    if (browser && !browser.session.guest)
        return true;
    const actor = verifiedInternalActor(c);
    return Boolean(actor && mcpGrantForActor(actor));
}
export function createAgentRouter(library, authorized = agentAccess) {
    const router = new Hono();
    router.use('*', async (c, next) => {
        c.header('Cache-Control', 'no-store');
        if (!authorized(c))
            return c.json({ error: 'AIセッションの表示にはDeckIDE所有者のログインまたは承認済み接続が必要です。' }, 403);
        return next();
    });
    router.get('/', async (c) => {
        try {
            return c.json(await library.list(c.req.query('search') || '', Number(c.req.query('offset') || 0), Number(c.req.query('limit') || 50), c.req.query('tool')));
        }
        catch {
            return c.json({ error: '一覧の指定が不正です。' }, 400);
        }
    });
    router.get('/:tool/:sourceId/:id', async (c) => {
        try {
            return c.json(await library.read(c.req.param('tool'), c.req.param('sourceId'), c.req.param('id')));
        }
        catch {
            return c.json({ error: 'このセッションを読み取れません。保存先と接続状態を確認してください。' }, 404);
        }
    });
    return router;
}
