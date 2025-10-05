// backend/seed-data.cjs
// Populate initial categories and sample events

const path = require('path');
const { MongoClient } = require('mongodb');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '.env') });

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || 'metainfosci_db';

if (!MONGODB_URI) {
  console.error('Missing MONGODB_URI in backend/.env');
  process.exit(1);
}

const mockEvents = [
  {
    title: "1 Day workshop on Bibliometric, Scientometric & Network Analysis",
    description: "Hosted by Center for Advanced Data and Computational Science, BML Munjal University",
    date: "September 30, 2025",
    location: "College of Vocational Studies, University of Delhi",
    images: [
      "https://i.ibb.co/9mv2KcvL/542c5861-dce1-4371-99ec-acd186c5e82d.jpg"
    ],
    category: "workshop",
    link: "/public/BIBLIOMETRIC_P.pdf",
    status: "Upcoming",
  },
  {
    title: "Hands-on session on MetaInfoSci",
    description: "Hosted by Center for Advanced Data and Computational Science, BML Munjal University",
    date: "April 23, 2025",
    location: "BMU",
    images: [
      "https://images.unsplash.com/photo-1540575467063-178a50c2df87?w=500",
      "https://images.unsplash.com/photo-1559136555-9303baea8ebd?w=500"
    ],
    category: "workshop",
    link: "#",
    status: "Concluded",
  },
  {
    title: "One Week Hands-on Workshop on Scientometrics & Network Science",
    description: "Hosted by Center for Advanced Data and Computational Science, BML Munjal University",
    date: "July 14 to 18, 2025",
    location: "Hub C- BML Munjal University (In-person)",
    images: [
      "https://images.unsplash.com/photo-1517048676732-d65bc937f952?w=500",
      "https://images.unsplash.com/photo-1552664730-d307ca884978?w=500"
    ],
    category: "workshop",
    link: "#",
    status: "Concluded",
  }
];

const defaultCategories = [
  { value: 'workshop', label: 'Workshop', order: 1 },
  { value: 'conference', label: 'Conference', order: 2 },
  { value: 'seminar', label: 'Seminar', order: 3 },
];

(async () => {
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    const events = db.collection('gallery_events');
    const categories = db.collection('event_categories');

    // Seed categories if empty
    const catCount = await categories.countDocuments();
    if (catCount === 0) {
      await categories.insertMany(defaultCategories);
      console.log('Inserted default categories');
    } else {
      console.log('Categories already present (skipping)');
    }

    // Seed events if empty
    const evtCount = await events.countDocuments();
    if (evtCount === 0) {
      const now = new Date();
      await events.insertMany(
        mockEvents.map((e) => ({ ...e, createdAt: now, updatedAt: now }))
      );
      console.log('Inserted mock events');
    } else {
      console.log('Events already present (skipping)');
    }
  } catch (err) {
    console.error('Seeding error:', err);
  } finally {
    await client.close();
  }
})();
