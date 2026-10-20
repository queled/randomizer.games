const mongoose = require('mongoose');
require('dotenv').config({ quiet: true });

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });
    console.log('✅ MongoDB connected successfully');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error.message);
    process.exit(1);
  }
};

mongoose.connection.on('error', (err) => {
  console.error('❌ MongoDB error:', err);
});

mongoose.connection.on('disconnected', () => {
  console.log('⚠️ MongoDB disconnected');
});

// Runs fn once MongoDB is connected: a query sent earlier sits in mongoose's
// buffer and times out after 10 s when the connection is slow to come up
const whenConnected = (fn) => {
  if (mongoose.connection.readyState === 1) fn();
  else mongoose.connection.once('open', fn);
};

module.exports = connectDB;
module.exports.whenConnected = whenConnected;
