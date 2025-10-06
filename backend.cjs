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
  return { events, categories, users, insights, teamMembers, manuals};
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
    const doc = await getPublicInsightsDoc();
    res.json({
      total_users: toNumberOrZero(doc.total_users),
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
    const docs = await events.find({}).sort({ createdAt: -1 }).toArray();
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

    if (!result?.value) return res.status(404).json({ error: 'Event not found' });
    res.json({ success: true, data: mapEvent(result.value) });
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
    for (const key of allowed) {
      if (key in updates) $set[key] = key === 'order' ? Number(updates[key]) : updates[key];
    }

    const { teamMembers } = collections();
    const result = await teamMembers.findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set },
      { returnDocument: 'after' }
    );
    if (!result?.value) return res.status(404).json({ error: 'Team member not found' });
    res.json({ success: true, data: mapTeamMember(result.value) });
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
    if (!result?.value) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true, data: mapUser(result.value) });
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
    for (const key of allowed) {
      if (key in updates) $set[key] = key === 'order' ? Number(updates[key]) : updates[key];
    }

    const { manuals } = collections();
    const result = await manuals.findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set },
      { returnDocument: 'after' }
    );
    if (!result?.value) return res.status(404).json({ error: 'Manual not found' });
    res.json({ success: true, data: mapManual(result.value) });
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

