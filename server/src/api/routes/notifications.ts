import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { ApiError } from '../../lib/errors';
import { Notification } from '../../models/Notification';
import { requireAuth } from '../middleware/auth';
import { serializeNotification } from '../serializers';

const router: Router = Router();
router.use(requireAuth);

/** GET /api/notifications — latest 50 + unread count (polled by the bell). */
router.get('/', async (req, res) => {
  const userId = req.user!._id;
  const [notifications, unreadCount] = await Promise.all([
    Notification.find({ userId }).sort({ createdAt: -1 }).limit(50),
    Notification.countDocuments({ userId, read: false }),
  ]);

  res.json({ notifications: notifications.map(serializeNotification), unreadCount });
});

const readSchema = z.object({
  ids: z.array(z.string()).optional(),
  all: z.boolean().optional(),
});

/** POST /api/notifications/read — mark some ({ids}) or all ({all: true}) as read. */
router.post('/read', async (req, res) => {
  const { ids, all } = readSchema.parse(req.body);
  const userId = req.user!._id;

  if (all) {
    await Notification.updateMany({ userId, read: false }, { read: true });
  } else if (ids?.length) {
    const validIds = ids.filter((id) => mongoose.isValidObjectId(id));
    await Notification.updateMany({ _id: { $in: validIds }, userId }, { read: true });
  } else {
    throw ApiError.badRequest('NOTHING_TO_MARK', 'Provide "ids" or "all: true"');
  }

  res.json({ ok: true });
});

export default router;
