import { Hono } from 'hono';
import { currentSession } from '../middleware/auth.js';
/** History is available only to a signed-in browser owner, never a guest/MCP grant. */
export function createCodexRouter(library, authorized = (c) => {
    const session = currentSession(c);
    return Boolean(session && !session.session.guest);
}) {
    const router = new Hono();
    router.use('*', async (c, next) => {
        c.header('Cache-Control', 'no-store');
        if (!authorized(c))
            return c.json({ error: 'Codex履歴の表示にはDeckIDEの所有者ログインが必要です。' }, 403);
        return next();
    });
    router.get('/', (c) => {
        try {
            return c.json(library.list(c.req.query('search') || '', Number(c.req.query('offset') || 0), Number(c.req.query('limit') || 50)));
        }
        catch {
            return c.json({ error: '一覧の指定が不正です。' }, 400);
        }
    });
    router.get('/:sourceId/:id', (c) => {
        try {
            return c.json(library.read(c.req.param('sourceId'), c.req.param('id')));
        }
        catch {
            return c.json({ error: 'この会話を読み取れません。保存先とアクセス権を確認してください。' }, 404);
        }
    });
    return router;
}
