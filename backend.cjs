// backend/backend.cjs
// CommonJS Express server for MongoDB-backed API (no auth)

const path = require('path');
const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '.env') });

const PORT = process.env.PORT || 5000;
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || 'metainfosci_db';

if (!MONGODB_URI) {
  console.error('Missing MONGODB_URI in backend/.env');
}

const app = express();
app.use(cors({ origin: true, credentials: false }));
app.use(express.json({ limit: '1mb' }));

const client = new MongoClient(MONGODB_URI, {
  retryWrites: true,
});

let db = null;

async function init() {
  try {
    await client.connect();
    db = client.db(DB_NAME);
    console.log(`[backend] Connected to MongoDB database: ${DB_NAME}`);
  } catch (err) {
    console.error('[backend] Failed to connect to MongoDB:', err.message);
    process.exit(1);
  }
}

function collections() {
  const events = db.collection('gallery_events');
  const categories = db.collection('event_categories');
  const users = db.collection('users');
  const insights = db.collection('public_insights');
  const teamMembers = db.collection('team_members');
  const manuals = db.collection('user_manuals');
  const testimonials = db.collection('testimonials');
  const carousel = db.collection('carousel');
  return { events, categories, users, insights, teamMembers, manuals, testimonials, carousel};
}

function mapEvent(doc) {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return { id: _id?.toString(), ...rest };
}

function mapUser(doc) {
  if (!doc) return null;
  const { _id, username, createdAt, updatedAt } = doc;
  return { id: _id?.toString(), username, createdAt, updatedAt };
}

function mapTeamMember(doc) {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return { id: _id?.toString(), ...rest };
}

function mapTestimonial(doc) {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return { id: _id?.toString(), ...rest };
}

/**
 * Helper function to handle order conflicts when updating an item's order
 * When setting an item to a specific order position, this function:
 * 1. Shifts items to make room for the new position
 * 2. Ensures no duplicate order values exist
 * 
 * @param {Collection} collection - MongoDB collection
 * @param {ObjectId} itemId - ID of the item being updated
 * @param {number} newOrder - New order value for the item
 * @param {object} filter - Additional filter criteria (e.g., { status: 'approved' })
 */
async function handleOrderConflict(collection, itemId, newOrder, filter = {}) {
  try {
    // Get the current item to check its old order
    const currentItem = await collection.findOne({ _id: itemId });
    const oldOrder = currentItem?.order ?? null;

    // If order hasn't changed, no need to do anything
    if (oldOrder === newOrder) {
      return;
    }

    console.log(`[handleOrderConflict] Moving item from order ${oldOrder} to ${newOrder}`);

    // Case 1: Moving DOWN (increasing order number, e.g., 1 -> 3)
    // Need to shift items between newOrder and oldOrder UP (decrease their order)
    if (oldOrder !== null && newOrder > oldOrder) {
      const itemsToShiftUp = await collection
        .find({
          _id: { $ne: itemId },
          order: { $gt: oldOrder, $lte: newOrder },
          ...filter
        })
        .toArray();

      if (itemsToShiftUp.length > 0) {
        console.log(`[handleOrderConflict] Shifting ${itemsToShiftUp.length} items UP (decreasing order)`);
        const bulkOps = itemsToShiftUp.map(item => ({
          updateOne: {
            filter: { _id: item._id },
            update: { $set: { order: item.order - 1, updatedAt: new Date() } }
          }
        }));
        
        await collection.bulkWrite(bulkOps);
      }
    }
    // Case 2: Moving UP (decreasing order number, e.g., 3 -> 1)
    // Need to shift items between newOrder and oldOrder DOWN (increase their order)
    else if (oldOrder !== null && newOrder < oldOrder) {
      const itemsToShiftDown = await collection
        .find({
          _id: { $ne: itemId },
          order: { $gte: newOrder, $lt: oldOrder },
          ...filter
        })
        .toArray();

      if (itemsToShiftDown.length > 0) {
        console.log(`[handleOrderConflict] Shifting ${itemsToShiftDown.length} items DOWN (increasing order)`);
        const bulkOps = itemsToShiftDown.map(item => ({
          updateOne: {
            filter: { _id: item._id },
            update: { $set: { order: item.order + 1, updatedAt: new Date() } }
          }
        }));
        
        await collection.bulkWrite(bulkOps);
      }
    }
    // Case 3: New item (oldOrder is null)
    // Shift all items at or after newOrder DOWN
    else if (oldOrder === null) {
      const itemsToShiftDown = await collection
        .find({
          _id: { $ne: itemId },
          order: { $gte: newOrder },
          ...filter
        })
        .toArray();

      if (itemsToShiftDown.length > 0) {
        console.log(`[handleOrderConflict] New item: Shifting ${itemsToShiftDown.length} items DOWN`);
        const bulkOps = itemsToShiftDown.map(item => ({
          updateOne: {
            filter: { _id: item._id },
            update: { $set: { order: item.order + 1, updatedAt: new Date() } }
          }
        }));
        
        await collection.bulkWrite(bulkOps);
      }
    }
  } catch (err) {
    console.error('Error handling order conflict:', err);
    // Don't throw - let the main update continue even if reordering fails
  }
}

function isValidUsername(u) {
  return typeof u === 'string' && u.length >= 1 && u.length <= 64 && /^[A-Za-z0-9._-]+$/.test(u);
}

function isValidPassword(p) {
  return typeof p === 'string' && p.length >= 8 && p.length <= 256;
}

app.get('/health', async (req, res) => {
  try {
    // Attempt a ping using a database command
    await db.command({ ping: 1 });
    res.json({ status: 'ok', database: 'connected', timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// Public insights (users/publications) storage helpers
async function getPublicInsightsDoc() {
  const { insights } = collections();
  let doc = await insights.findOne({ key: 'global' });
  if (!doc) {
    doc = {
      key: 'global',
      total_users: 0,
      total_publications: 0,
      updatedAt: new Date(),
      source: 'init',
    };
    await insights.insertOne(doc);
  }
  return doc;
}

function toNumberOrZero(val) {
  const n = Number(val);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// GET public insights (no auth)
app.get('/admin-services/public/platform-insights/', async (req, res) => {
  try {
    const { users } = collections();
    // Count total users from database instead of using cache
    const totalUsersCount = await users.countDocuments({});
    
    const doc = await getPublicInsightsDoc();
    res.json({
      total_users: totalUsersCount,
      total_publications: toNumberOrZero(doc.total_publications),
      updated_at: doc.updatedAt,
    });
  } catch (err) {
    console.error('GET /public/platform-insights error:', err);
    res.status(500).json({ error: 'Failed to fetch public insights' });
  }
});

// UPSERT (increase-only) public insights (currently no auth; consider protecting in production)
app.post('/admin-services/platform-insights/cache-upsert', async (req, res) => {
  try {
    const { total_users, total_publications } = req.body || {};
    const incomingUsers = toNumberOrZero(total_users);
    const incomingPubs = toNumberOrZero(total_publications);

    const { insights } = collections();
    const now = new Date();
    const doc = await getPublicInsightsDoc();

    const updates = {};
    let changed = false;

    if (incomingUsers > toNumberOrZero(doc.total_users)) {
      updates.total_users = incomingUsers;
      changed = true;
    }
    if (incomingPubs > toNumberOrZero(doc.total_publications)) {
      updates.total_publications = incomingPubs;
      changed = true;
    }

    if (changed) {
      updates.updatedAt = now;
      updates.source = 'client-upsert';
      await insights.updateOne({ key: 'global' }, { $set: updates });
    }

    const latest = await insights.findOne({ key: 'global' });
    res.json({ success: true, updated: changed, data: {
      total_users: toNumberOrZero(latest.total_users),
      total_publications: toNumberOrZero(latest.total_publications),
      updated_at: latest.updatedAt,
    }});
  } catch (err) {
    console.error('POST /platform-insights/cache-upsert error:', err);
    res.status(500).json({ error: 'Failed to upsert public insights' });
  }
});

// GET all events
app.get('/admin-services/gallery-events/', async (req, res) => {
  try {
    const { events } = collections();
    const docs = await events.find({}).sort({ date: 1, createdAt: -1 }).toArray();
    res.json(docs.map(mapEvent));
  } catch (err) {
    console.error('GET /gallery-events error:', err);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

// CREATE event
app.post('/admin-services/gallery-events/', async (req, res) => {
  try {
    const { events } = collections();
    const payload = req.body || {};

    if (!payload.title || typeof payload.title !== 'string') {
      return res.status(400).json({ error: 'title is required' });
    }

    const now = new Date();
    const newEvent = {
      title: payload.title,
      description: payload.description || '',
      date: payload.date || '',
      end_date: payload.end_date ? payload.end_date : null,
      location: payload.location || '',
      images: Array.isArray(payload.images) ? payload.images : [],
      category: payload.category || '',
      link: payload.link || '',
      status: payload.status || '',
      attendees: typeof payload.attendees === 'number' ? payload.attendees : undefined,
      createdAt: now,
      updatedAt: now,
    };

    const result = await events.insertOne(newEvent);
    newEvent._id = result.insertedId;

    res.status(201).json({ success: true, data: mapEvent(newEvent) });
  } catch (err) {
    console.error('POST /gallery-events error:', err);
    res.status(500).json({ error: 'Failed to create event' });
  }
});

// UPDATE event
app.put('/admin-services/gallery-events/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid id' });
    }
    const updates = req.body || {};
    const allowed = ['title', 'description', 'date', 'end_date', 'location', 'images', 'category', 'link', 'status', 'attendees'];
    const $set = { updatedAt: new Date() };
    for (const key of allowed) {
      if (key in updates) $set[key] = updates[key];
    }

    const { events } = collections();
    const result = await events.findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set },
      { returnDocument: 'after' }
    );

    if (!result) return res.status(404).json({ error: 'Event not found' });
    res.json({ success: true, data: mapEvent(result) });
  } catch (err) {
    console.error('PUT /gallery-events/:id error:', err);
    res.status(500).json({ error: 'Failed to update event' });
  }
});

// DELETE event
app.delete('/admin-services/gallery-events/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid id' });
    }
    const { events } = collections();
    const result = await events.deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'Event not found' });
    res.json({ success: true, deleted: 1 });
  } catch (err) {
    console.error('DELETE /gallery-events/:id error:', err);
    res.status(500).json({ error: 'Failed to delete event' });
  }
});

// GET categories
app.get('/admin-services/events/categories/', async (req, res) => {
  try {
    const { categories } = collections();
    const docs = await categories.find({}).sort({ order: 1, label: 1 }).toArray();

    if (!docs || docs.length === 0) {
      // Provide reasonable defaults if none present
      return res.json([
        { value: 'workshop', label: 'Workshop' },
        { value: 'conference', label: 'Conference' },
        { value: 'seminar', label: 'Seminar' },
      ]);
    }

    const response = docs.map((d) => ({ value: d.value, label: d.label }));
    res.json(response);
  } catch (err) {
    console.error('GET /events/categories error:', err);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

// TEAM MEMBERS CRUD
app.get('/admin-services/team-members/', async (req, res) => {
  try {
    const { teamMembers } = collections();
    const docs = await teamMembers.find({}).sort({ order: 1, createdAt: -1 }).toArray();
    res.json(docs.map(mapTeamMember));
  } catch (err) {
    console.error('GET /team-members error:', err);
    res.status(500).json({ error: 'Failed to fetch team members' });
  }
});

app.post('/admin-services/team-members/', async (req, res) => {
  try {
    const payload = req.body || {};
    if (!payload.name || typeof payload.name !== 'string') {
      return res.status(400).json({ error: 'name is required' });
    }

    const now = new Date();
    const doc = {
      name: payload.name,
      affiliation: typeof payload.affiliation === 'string' ? payload.affiliation : '',
      position1: typeof payload.position1 === 'string' ? payload.position1 : '',
      position2: typeof payload.position2 === 'string' ? payload.position2 : '',
      avatar_url: typeof payload.avatar_url === 'string' ? payload.avatar_url : '',
      scholar_url: typeof payload.scholar_url === 'string' ? payload.scholar_url : '',
      linkedin_url: typeof payload.linkedin_url === 'string' ? payload.linkedin_url : '',
      position1_link: typeof payload.position1_link === 'string' ? payload.position1_link : '',
      position2_link: typeof payload.position2_link === 'string' ? payload.position2_link : '',
      affiliation_link: typeof payload.affiliation_link === 'string' ? payload.affiliation_link : '',
      order: Number.isFinite(Number(payload.order)) ? Number(payload.order) : 0,
      published: payload.published !== undefined ? !!payload.published : true,
      createdAt: now,
      updatedAt: now,
    };

    const { teamMembers } = collections();
    const result = await teamMembers.insertOne(doc);
    doc._id = result.insertedId;
    res.status(201).json({ success: true, data: mapTeamMember(doc) });
  } catch (err) {
    console.error('POST /team-members error:', err);
    res.status(500).json({ error: 'Failed to create team member' });
  }
});

app.put('/admin-services/team-members/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });
    const updates = req.body || {};
    const allowed = ['name', 'affiliation', 'position1', 'position2', 'avatar_url', 'scholar_url', 'linkedin_url', 'position1_link', 'position2_link', 'affiliation_link', 'order', 'published'];
    const $set = { updatedAt: new Date() };
    
    // Check if order is being updated
    const isOrderUpdate = 'order' in updates;
    const newOrder = isOrderUpdate ? Number(updates.order) : null;
    
    for (const key of allowed) {
      if (key in updates) $set[key] = key === 'order' ? Number(updates[key]) : updates[key];
    }

    const { teamMembers } = collections();
    
    // Handle order conflicts before updating
    if (isOrderUpdate && Number.isFinite(newOrder)) {
      await handleOrderConflict(teamMembers, new ObjectId(id), newOrder);
    }
    
    const result = await teamMembers.findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set },
      { returnDocument: 'after' }
    );
    if (!result) return res.status(404).json({ error: 'Team member not found' });
    res.json({ success: true, data: mapTeamMember(result) });
  } catch (err) {
    console.error('PUT /team-members/:id error:', err);
    res.status(500).json({ error: 'Failed to update team member' });
  }
});

app.delete('/admin-services/team-members/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });
    const { teamMembers } = collections();
    const result = await teamMembers.deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'Team member not found' });
    res.json({ success: true, deleted: 1 });
  } catch (err) {
    console.error('DELETE /team-members/:id error:', err);
    res.status(500).json({ error: 'Failed to delete team member' });
  }
});

// PUBLIC TEAM MEMBERS
app.get('/admin-services/public/team-members/', async (req, res) => {
  try {
    const { teamMembers } = collections();
    const docs = await teamMembers.find({ published: true }).sort({ order: 1, createdAt: -1 }).toArray();
    res.json(docs.map(mapTeamMember));
  } catch (err) {
    console.error('GET /public/team-members error:', err);
    res.status(500).json({ error: 'Failed to fetch team members' });
  }
});

// USERS CRUD (secure password hashing)
app.get('/admin-services/users/', async (req, res) => {
  try {
    const { users } = collections();
    const docs = await users.find({}).sort({ createdAt: -1 }).toArray();
    res.json(docs.map(mapUser));
  } catch (err) {
    console.error('GET /users error:', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

app.post('/admin-services/users/', async (req, res) => {
  try {
    const { users } = collections();
    const { username, password } = req.body || {};

    if (!isValidUsername(username)) {
      return res.status(400).json({ error: 'Invalid username' });
    }
    if (!isValidPassword(password)) {
      return res.status(400).json({ error: 'Invalid password (min 8 chars)' });
    }

    const existing = await users.findOne({ username });
    if (existing) return res.status(409).json({ error: 'Username already exists' });

    const hash = await bcrypt.hash(password, 12);
    const now = new Date();
    const userDoc = { username, passwordHash: hash, createdAt: now, updatedAt: now };
    const result = await users.insertOne(userDoc);
    userDoc._id = result.insertedId;
    res.status(201).json({ success: true, data: mapUser(userDoc) });
  } catch (err) {
    console.error('POST /users error:', err);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

app.put('/admin-services/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });

    const { username, password } = req.body || {};
    const $set = { updatedAt: new Date() };

    if (username !== undefined) {
      if (!isValidUsername(username)) return res.status(400).json({ error: 'Invalid username' });
      const { users } = collections();
      const existing = await users.findOne({ username, _id: { $ne: new ObjectId(id) } });
      if (existing) return res.status(409).json({ error: 'Username already exists' });
      $set.username = username;
    }
    if (password !== undefined && password !== '') {
      if (!isValidPassword(password)) return res.status(400).json({ error: 'Invalid password (min 8 chars)' });
      $set.passwordHash = await bcrypt.hash(password, 12);
    }

    const { users } = collections();
    const result = await users.findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set },
      { returnDocument: 'after' }
    );
    if (!result) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true, data: mapUser(result) });
  } catch (err) {
    console.error('PUT /users/:id error:', err);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

app.delete('/admin-services/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });
    const { users } = collections();
    const result = await users.deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true, deleted: 1 });
  } catch (err) {
    console.error('DELETE /users/:id error:', err);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// LOGIN: verify username/password
app.post('/admin-services/users/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'username and password are required' });
    }
    const { users } = collections();
    const user = await users.findOne({ username });
    if (!user || !user.passwordHash) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    return res.json({ success: true, data: mapUser(user) });
  } catch (err) {
    console.error('POST /users/login error:', err);
    res.status(500).json({ error: 'Failed to login' });
  }
});

// Helper function for mapping manual documents
function mapManual(doc) {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return { id: _id?.toString(), ...rest };
}

// GET all manuals (public - for UserManual page)
app.get('/admin-services/public/user-manuals/', async (req, res) => {
  try {
    const { manuals } = collections();
    const docs = await manuals.find({ published: true }).sort({ order: 1, createdAt: -1 }).toArray();
    res.json(docs.map(mapManual));
  } catch (err) {
    console.error('GET /public/user-manuals error:', err);
    res.status(500).json({ error: 'Failed to fetch manuals' });
  }
});

// GET all manuals (admin)
app.get('/admin-services/user-manuals/', async (req, res) => {
  try {
    const { manuals } = collections();
    const docs = await manuals.find({}).sort({ order: 1, createdAt: -1 }).toArray();
    res.json(docs.map(mapManual));
  } catch (err) {
    console.error('GET /user-manuals error:', err);
    res.status(500).json({ error: 'Failed to fetch manuals' });
  }
});

// CREATE manual
app.post('/admin-services/user-manuals/', async (req, res) => {
  try {
    const payload = req.body || {};
    if (!payload.title || typeof payload.title !== 'string') {
      return res.status(400).json({ error: 'title is required' });
    }

    const now = new Date();
    const doc = {
      title: payload.title,
      description: typeof payload.description === 'string' ? payload.description : '',
      video_url: typeof payload.video_url === 'string' ? payload.video_url : '',
      thumbnail_url: typeof payload.thumbnail_url === 'string' ? payload.thumbnail_url : '',
      manual_pdf_url: typeof payload.manual_pdf_url === 'string' ? payload.manual_pdf_url : '',
      order: Number.isFinite(Number(payload.order)) ? Number(payload.order) : 0,
      published: payload.published !== undefined ? !!payload.published : true,
      createdAt: now,
      updatedAt: now,
    };

    const { manuals } = collections();
    const result = await manuals.insertOne(doc);
    doc._id = result.insertedId;
    res.status(201).json({ success: true, data: mapManual(doc) });
  } catch (err) {
    console.error('POST /user-manuals error:', err);
    res.status(500).json({ error: 'Failed to create manual' });
  }
});

// UPDATE manual
app.put('/admin-services/user-manuals/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });
    const updates = req.body || {};
    const allowed = ['title', 'description', 'video_url', 'thumbnail_url', 'manual_pdf_url', 'order', 'published'];
    const $set = { updatedAt: new Date() };
    
    // Check if order is being updated
    const isOrderUpdate = 'order' in updates;
    const newOrder = isOrderUpdate ? Number(updates.order) : null;
    
    for (const key of allowed) {
      if (key in updates) $set[key] = key === 'order' ? Number(updates[key]) : updates[key];
    }

    const { manuals } = collections();
    
    // Handle order conflicts before updating
    if (isOrderUpdate && Number.isFinite(newOrder)) {
      await handleOrderConflict(manuals, new ObjectId(id), newOrder);
    }
    
    const result = await manuals.findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set },
      { returnDocument: 'after' }
    );
    if (!result) return res.status(404).json({ error: 'Manual not found' });
    res.json({ success: true, data: mapManual(result) });
  } catch (err) {
    console.error('PUT /user-manuals/:id error:', err);
    res.status(500).json({ error: 'Failed to update manual' });
  }
});

// DELETE manual
app.delete('/admin-services/user-manuals/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });
    const { manuals } = collections();
    const result = await manuals.deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'Manual not found' });
    res.json({ success: true, deleted: 1 });
  } catch (err) {
    console.error('DELETE /user-manuals/:id error:', err);
    res.status(500).json({ error: 'Failed to delete manual' });
  }
});


// TESTIMONIALS CRUD (public API - no auth required)
// GET all approved testimonials (public)
app.get('/admin-services/testimonials/', async (req, res) => {
  try {
    const { testimonials } = collections();
    const docs = await testimonials
      .find({ status: 'approved' })
      .sort({ order: 1, submitted_at: -1 })
      .toArray();
    
    // Ensure all testimonials have an order field (default to 0 if missing)
    const docsWithOrder = docs.map(doc => ({
      ...doc,
      order: doc.order !== undefined ? doc.order : 0
    }));
    
    res.json({ success: true, testimonials: docsWithOrder.map(mapTestimonial) });
  } catch (err) {
    console.error('GET /testimonials error:', err);
    res.status(500).json({ error: 'Failed to fetch testimonials' });
  }
});

// POST new testimonial (public - submit)
app.post('/admin-services/testimonials/', async (req, res) => {
  try {
    const { name, title, organization, email, content, border_color, profile_image } = req.body || {};

    console.log('Received testimonial submission:', {
      name,
      email,
      profile_image,
      profile_image_length: profile_image?.length
    });

    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'name is required' });
    }
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'email is required' });
    }
    if (!content || typeof content !== 'string') {
      return res.status(400).json({ error: 'content is required' });
    }

    const { testimonials } = collections();

    // Check if user already has a pending or approved testimonial
    const existingTestimonial = await testimonials.findOne({
      email: email.trim(),
      status: { $in: ['pending', 'approved'] }
    });

    if (existingTestimonial) {
      console.log('Duplicate testimonial attempt for:', email);
      return res.status(400).json({ 
        error: 'You have already submitted a testimonial. Please wait for admin review.',
        code: 'DUPLICATE_TESTIMONIAL'
      });
    }

    const now = new Date();
    const doc = {
      name: name.trim(),
      title: typeof title === 'string' ? title.trim() : '',
      organization: typeof organization === 'string' ? organization.trim() : '',
      email: email.trim(),
      content: content.trim(),
      border_color: ['red', 'orange', 'blue', 'green', 'purple'].includes(border_color) ? border_color : 'blue',
      profile_image: typeof profile_image === 'string' ? profile_image.trim() : '',
      status: 'pending',
      order: 0,
      is_featured: false,
      submitted_at: now,
      reviewed_at: null,
      reviewed_by: null,
      submitted_by: null,
    };

    console.log('Saving testimonial with profile_image:', doc.profile_image);

    const result = await testimonials.insertOne(doc);
    doc._id = result.insertedId;

    console.log('Saved testimonial, returning:', { id: doc._id, profile_image: doc.profile_image });

    res.status(201).json({ success: true, data: mapTestimonial(doc) });
  } catch (err) {
    console.error('POST /testimonials error:', err);
    res.status(500).json({ error: 'Failed to submit testimonial' });
  }
});

// GET all testimonials (admin - all statuses)
app.get('/admin-services/testimonials/admin/all', async (req, res) => {
  try {
    const { testimonials } = collections();
    const docs = await testimonials
      .find({})
      .sort({ order: 1, submitted_at: -1 })
      .toArray();
    
    // Ensure all testimonials have an order field (default to 0 if missing)
    const docsWithOrder = docs.map(doc => ({
      ...doc,
      order: doc.order !== undefined ? doc.order : 0
    }));
    
    res.json({ success: true, testimonials: docsWithOrder.map(mapTestimonial) });
  } catch (err) {
    console.error('GET /testimonials/admin/all error:', err);
    res.status(500).json({ error: 'Failed to fetch testimonials' });
  }
});

// UPDATE testimonial (admin - approve/reject/edit)
app.put('/admin-services/testimonials/:id', async (req, res) => {
  try {
    const { id } = req.params;
    console.log('PUT /testimonials/:id - Received ID:', id);
    console.log('PUT /testimonials/:id - Request body:', req.body);
    
    if (!ObjectId.isValid(id)) {
      console.log('PUT /testimonials/:id - Invalid ObjectId');
      return res.status(400).json({ error: 'Invalid id' });
    }

    const updates = req.body || {};
    const allowed = ['name', 'title', 'organization', 'email', 'content', 'border_color', 'status', 'order', 'is_featured', 'profile_image'];
    const $set = { updatedAt: new Date() };

    // Check if order is being updated
    const isOrderUpdate = 'order' in updates;
    const newOrder = isOrderUpdate ? Number(updates.order) : null;

    for (const key of allowed) {
      if (key in updates) {
        if (key === 'order') {
          $set[key] = Number(updates[key]);
        } else if (key === 'is_featured') {
          $set[key] = !!updates[key];
        } else if (key === 'status') {
          if (['pending', 'approved', 'rejected'].includes(updates[key])) {
            $set[key] = updates[key];
            if (updates[key] !== 'pending') {
              $set.reviewed_at = new Date();
            }
          }
        } else if (key === 'border_color') {
          if (['red', 'orange', 'blue', 'green', 'purple'].includes(updates[key])) {
            $set[key] = updates[key];
          }
        } else {
          $set[key] = updates[key];
        }
      }
    }

    console.log('PUT /testimonials/:id - Updates to apply:', $set);

    const { testimonials } = collections();
    
    // Handle order conflicts before updating (only for approved testimonials)
    if (isOrderUpdate && Number.isFinite(newOrder)) {
      await handleOrderConflict(testimonials, new ObjectId(id), newOrder, { status: 'approved' });
    }
    
    const result = await testimonials.findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set },
      { returnDocument: 'after' }
    );

    console.log('PUT /testimonials/:id - MongoDB result:', result);

    // MongoDB driver returns the document directly in 'result', not 'result.value'
    if (!result) {
      console.log('PUT /testimonials/:id - Testimonial not found in database');
      return res.status(404).json({ error: 'Testimonial not found' });
    }
    
    console.log('PUT /testimonials/:id - Success!');
    res.json({ success: true, data: mapTestimonial(result) });
  } catch (err) {
    console.error('PUT /testimonials/:id error:', err);
    res.status(500).json({ error: 'Failed to update testimonial' });
  }
});

// DELETE testimonial (admin)
app.delete('/admin-services/testimonials/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid id' });
    }

    const { testimonials } = collections();
    const result = await testimonials.deleteOne({ _id: new ObjectId(id) });

    if (result.deletedCount === 0) return res.status(404).json({ error: 'Testimonial not found' });
    res.json({ success: true, deleted: 1 });
  } catch (err) {
    console.error('DELETE /testimonials/:id error:', err);
    res.status(500).json({ error: 'Failed to delete testimonial' });
  }
});

// CAROUSEL SEEDING - Initialize carousel with default images (run once)
app.post('/admin-services/carousel/seed', async (req, res) => {
  try {
    const { carousel } = collections();
    
    // Check if carousel already has images
    const existingCount = await carousel.countDocuments({});
    if (existingCount > 0) {
      return res.json({ success: true, message: 'Carousel already seeded', count: existingCount });
    }

    // Default carousel images
    const defaultImages = [
      { image_url: "/images/carousel/F1.png", title: "Dashboard Preview 1", order: 0 },
      { image_url: "/images/carousel/F2.png", title: "Dashboard Preview 2", order: 1 },
      { image_url: "/images/carousel/F3.png", title: "Dashboard Preview 3", order: 2 },
      { image_url: "/images/carousel/F4.jpeg", title: "Dashboard Preview 4", order: 3 },
      { image_url: "/images/carousel/F5.png", title: "Dashboard Preview 5", order: 4 },
    ];

    const now = new Date();
    const docsToInsert = defaultImages.map(img => ({
      ...img,
      description: "",
      is_active: true,
      createdAt: now,
      updatedAt: now,
    }));

    const result = await carousel.insertMany(docsToInsert);
    res.json({ success: true, message: 'Carousel seeded successfully', inserted: result.insertedIds.length });
  } catch (err) {
    console.error('POST /carousel/seed error:', err);
    res.status(500).json({ error: 'Failed to seed carousel' });
  }
});

// CAROUSEL CRUD (admin - manage carousel images)
// GET all carousel images
app.get('/admin-services/carousel/', async (req, res) => {
  try {
    const { carousel } = collections();
    const docs = await carousel.find({}).sort({ order: 1, createdAt: -1 }).toArray();
    
    // Ensure all carousel items have an order field (default to 0 if missing)
    const docsWithOrder = docs.map(doc => ({
      ...doc,
      order: doc.order !== undefined ? doc.order : 0
    }));
    
    res.json({ success: true, carousel: docsWithOrder.map(mapEvent) });
  } catch (err) {
    console.error('GET /carousel error:', err);
    res.status(500).json({ error: 'Failed to fetch carousel images' });
  }
});

// POST new carousel image
app.post('/admin-services/carousel/', async (req, res) => {
  try {
    const { carousel } = collections();
    const payload = req.body || {};

    if (!payload.image_url || typeof payload.image_url !== 'string') {
      return res.status(400).json({ error: 'image_url is required' });
    }

    const now = new Date();
    const newCarousel = {
      image_url: payload.image_url.trim(),
      title: payload.title || '',
      description: payload.description || '',
      order: typeof payload.order === 'number' ? payload.order : 0,
      is_active: payload.is_active !== false,
      createdAt: now,
      updatedAt: now,
    };

    const result = await carousel.insertOne(newCarousel);
    newCarousel._id = result.insertedId;

    res.status(201).json({ success: true, data: mapEvent(newCarousel) });
  } catch (err) {
    console.error('POST /carousel error:', err);
    res.status(500).json({ error: 'Failed to create carousel image' });
  }
});

// UPDATE carousel image
app.put('/admin-services/carousel/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid id' });
    }

    const updates = req.body || {};
    const allowed = ['image_url', 'title', 'description', 'order', 'is_active'];
    const $set = { updatedAt: new Date() };

    // Check if order is being updated
    const isOrderUpdate = 'order' in updates;
    const newOrder = isOrderUpdate ? Number(updates.order) : null;

    for (const key of allowed) {
      if (key in updates) {
        if (key === 'order') {
          $set[key] = Number(updates[key]);
        } else if (key === 'is_active') {
          $set[key] = !!updates[key];
        } else {
          $set[key] = updates[key];
        }
      }
    }

    const { carousel } = collections();
    
    // Handle order conflicts before updating
    if (isOrderUpdate && Number.isFinite(newOrder)) {
      await handleOrderConflict(carousel, new ObjectId(id), newOrder);
    }
    
    const result = await carousel.findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set },
      { returnDocument: 'after' }
    );

    if (!result) {
      return res.status(404).json({ error: 'Carousel image not found' });
    }
    
    res.json({ success: true, data: mapEvent(result) });
  } catch (err) {
    console.error('PUT /carousel/:id error:', err);
    res.status(500).json({ error: 'Failed to update carousel image' });
  }
});

// DELETE carousel image
app.delete('/admin-services/carousel/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid id' });
    }

    const { carousel } = collections();
    const result = await carousel.deleteOne({ _id: new ObjectId(id) });

    if (result.deletedCount === 0) return res.status(404).json({ error: 'Carousel image not found' });
    res.json({ success: true, deleted: 1 });
  } catch (err) {
    console.error('DELETE /carousel/:id error:', err);
    res.status(500).json({ error: 'Failed to delete carousel image' });
  }
});

// Start server after DB connects
init().then(() => {
  app.listen(PORT, () => {
    console.log(`[backend] Server listening on http://127.0.0.1:${PORT}`);
  });
});

process.on('SIGINT', async () => {
  try {
    await client.close();
  } catch (e) {}
  process.exit(0);
});

