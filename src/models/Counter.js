const mongoose = require('mongoose');

const counterSchema = new mongoose.Schema({
  key: { 
    type: String, 
    unique: true, 
    required: true 
  },
  seq: { 
    type: Number, 
    default: 0 
  }
});

module.exports = mongoose.model('Counter', counterSchema);