require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const saltRounds = 10;

const multer = require('multer');
const cloudinary = require('cloudinary').v2;


const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { GridFSBucket } = require('mongodb');
const requestCache = new Map();
const { RtcTokenBuilder, RtcRole } = require('agora-access-token');
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' })); 

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    // Allow specific file types
    const allowedTypes = [
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
      'application/pdf', 'application/msword', 
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/plain', 'text/csv'
    ];
    
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('File type not allowed'), false);
    }
  }
});

const {
  ADMIN_USERNAME,
  ADMIN_PASSWORD,
  JWT_SECRET,
  DEFAULT_STUDENT_PASSWORD,
  DEFAULT_FACULTY_PASSWORD,
  PORT = 5000
} = process.env;

const getProgramFromStudentId = (studentId) => {
  const parts = studentId.split('-');
  if (parts.length < 4) return 'Undecided';
  const departmentCode = parts[2];
  switch(departmentCode) {
    case '60': return 'Computer Science';
    case '50': return 'Electrical Engineering';
    default: return 'Undecided';
  }
};

if (!ADMIN_USERNAME || !ADMIN_PASSWORD || !JWT_SECRET || !DEFAULT_STUDENT_PASSWORD) {
  console.error('Missing required environment variables');
  process.exit(1);
}


mongoose.connect(
  `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}/${process.env.DB_NAME}?retryWrites=true&w=majority&appName=Cluster0`,
  {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  }
)
.then(() => console.log('Connected to MongoDB'))
.catch(err => console.error('Could not connect to MongoDB', err));


// ✅ ADD THIS HELPER FUNCTION
const createNotification = async (recipientId, type, title, message, data = {}) => {
  try {
    const notification = new Notification({
      recipientId,
      type,
      title,
      message,
      data,
      read: false,
      createdAt: new Date()
    });

    await notification.save();
    console.log(`📬 Notification created for user ${recipientId}: ${title}`);
    return notification;
  } catch (error) {
    console.error('Error creating notification:', error);
    return null;
  }
};


// Notification Schema
const notificationSchema = new mongoose.Schema({
  recipientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
  type: { type: String, enum: ['team_request', 'team_accepted', 'team_rejected', 'general'], default: 'team_request' },
  title: { type: String, required: true },
  message: { type: String, required: true },
  data: {
    senderName: String,
    senderStudentId: String,
    teamName: String,
    requestId: String
  },
  read: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

const Notification = mongoose.model('Notification', notificationSchema);

// Notification creation function
const createTeamRequestNotification = async ({
  recipientId,
  senderName,
  senderStudentId,
  teamName,
  requestId,
  message
}) => {
  try {
    const notification = new Notification({
      recipientId,
      type: 'team_request',
      title: 'New Team Request',
      message: message,
      data: {
        senderName,
        senderStudentId,
        teamName,
        requestId
      }
    });

    await notification.save();
    console.log(`Notification created for student ${recipientId}`);
    return notification;
  } catch (error) {
    console.error('Error creating notification:', error);
  }
};

const autoGroupSettingsSchema = new mongoose.Schema({
  enabled: { type: Boolean, default: false },
  minCreditsRequired: { type: Number, default: 95 },
  allowSoloGroups: { type: Boolean, default: true },
  checkIntervalMinutes: { type: Number, default: 30 },
  autoCreateThreshold: { type: Number, default: 4 },
  lastCheck: { type: Date, default: Date.now },
  totalAutoGroups: { type: Number, default: 0 }
});

const AutoGroupSettings = mongoose.model('AutoGroupSettings', autoGroupSettingsSchema);
// Chat Message Schema
const chatMessageSchema = new mongoose.Schema({
  teamId: { type: mongoose.Schema.Types.ObjectId, ref: 'Team', required: true },
  senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
  senderName: { type: String, required: true },
  senderStudentId: { type: String, required: true },
  message: { type: String, default: '' },
  messageType: {
    type: String,
    enum: ['text', 'file', 'image'],
    default: 'text'
  },
  file: {
    public_id: String,
    url: String,
    originalName: String,
    size: Number,
    mimetype: String,
    format: String,
    resource_type: String
  },
  timestamp: { type: Date, default: Date.now },
  editedAt: Date,
  isEdited: { type: Boolean, default: false }
}, { timestamps: true });


const ChatMessage = mongoose.model('ChatMessage', chatMessageSchema);


// Annoucement Schema
const announcementSchema = new mongoose.Schema({
  title: String,
  content: String,
  author: String,
  date: String,
  audience: String,
  status: String
});

const Announcement = mongoose.model('Announcement', announcementSchema);

// Store new announcements
app.post('/api/announcements', async (req, res) => {
  try {
    const { title, content, author, date, audience, status } = req.body;

    const newAnnouncement = new Announcement({
      title,
      content,
      author,
      date,
      audience,
      status,
    });

    const savedAnnouncement = await newAnnouncement.save();

    res.status(201).json({ message: 'Announcement created successfully', announcement: savedAnnouncement });
  } catch (error) {
    console.error('Error creating announcement:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Get all announcements
app.get('/api/announcements', async (req, res) => {
  try {
    const announcements = await Announcement.find();
    res.json(announcements);
  } catch (err) {
    console.error('Error fetching announcements: ', err);
    res.status(500).json({ message: 'Error fetching announcements' });
  }
});

// Update an existing announcement
app.put('/api/announcements/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, content, author, date, audience, status } = req.body;

    const updatedAnnouncement = await Announcement.findByIdAndUpdate(
      id,
      { title, content, author, date, audience, status },
      { new: true }
    );

    if (!updatedAnnouncement) {
      return res.status(404).json({ message: 'Announcement not found' });
    }

    res.json({ message: 'Announcement updated successfully', announcement: updatedAnnouncement });
  } catch (error) {
    console.error('Error updating announcement:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Delete an announcement by ID
app.delete('/api/announcements/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const deleted = await Announcement.findByIdAndDelete(id);

    if (!deleted) {
      return res.status(404).json({ message: 'Announcement not found' });
    }

    res.json({ message: 'Announcement deleted successfully' });
  } catch (error) {
    console.error('Error deleting announcement:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Get announcements for a specific audience with status Published
app.get('/api/announcements/audience/:audience', async (req, res) => {
  try {
    const audience = req.params.audience;
    const announcements = await Announcement.find({
      audience: { $in: [audience, "All Concerned"] },
      status: "Published"
    }).sort({ date: -1 });

    res.json(announcements);
  } catch (error) {
    console.error('Error fetching announcements:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// User dismiss an Announcement
app.put('/api/announcements/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const updated = await Announcement.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ message: 'Announcement not found' });
    }

    res.json({ message: 'Status updated', announcement: updated });
  } catch (error) {
    console.error('Error updating status:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Get the specific author data
app.get('/api/announcements/author/:author', async (req, res) => {
  try {
    const author = req.params.author;
    const announcements = await Announcement.find({
      author,
      status: "Published"
    }).sort({ date: -1 });

    res.json(announcements);
  } catch (error) {
    console.error('Error fetching announcements:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Admin Schema
const adminSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  password: { type: String, required: true }
});

// Faculty Schema
const facultySchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  department: { type: String, required: true },
  role: { type: String },
  status: { type: String, default: 'Active' },
  phone: String,
  office: String,
  joined: { type: Date, default: Date.now },
  password: { type: String, required: true },
  profilePicture: { type: String },
  visibleToStudents: { type: Boolean, default: false },
  resetToken: String,
  resetTokenExpiry: Date
}, { strict: false }); 

const activationRequestSchema = new mongoose.Schema({
  studentId: { type: String, required: true, unique: true },
  createdAt: { type: Date, default: Date.now },
  status: { 
    type: String, 
    enum: ['pending', 'approved', 'rejected', 'cancelled'], 
    default: 'pending' }
});

// Team Rejection Tracking Schema
const teamRejectionSchema = new mongoose.Schema({
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
  teamId: { type: mongoose.Schema.Types.ObjectId, ref: 'Team', required: true },
  rejectionCount: { type: Number, default: 0 },
  lastRejectedDate: { type: Date, default: Date.now }
}, { timestamps: true });

const TeamRejection = mongoose.model('TeamRejection', teamRejectionSchema);

// Updated Student Schema with avatar field for base64 storage
// In server.js - Fix the student schema
const studentSchema = new mongoose.Schema({
  studentId: { 
    type: String, 
    required: [true, 'Student ID is required'],
    unique: true,
    validate: {
      validator: v => /^\d{4}-\d-\d{2}-\d{3}$/.test(v),
      message: 'Invalid Student ID format'
    }
  },
  password: { type: String, required: true },
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  program: {
    type: String,
    required: [true, 'Program is required']
  },
  avatar: {
    type: String, // CHANGED FROM ObjectId TO String for base64
    default: null
  },
  status: { 
    type: String, 
    enum: ['Active', 'Inactive', 'Probation', 'Graduated'], 
    default: 'Active' 
  },
  phone: String,
  address: String,
  enrolled: { type: Date, default: Date.now },
  completedCredits: {
    type: Number,
    required: [true, 'Completed credits are required'],
    min: [0, 'Credits cannot be negative'],
    max: [150, 'Credits exceed maximum allowed']
  },
  cgpa: {
    type: Number,
    required: [true, 'CGPA is required'],
    min: [0, 'CGPA cannot be less than 0'],
    max: [4, 'CGPA cannot exceed 4.0'],
    default: 0.0
  },
   passwordChangedAt: {
    type: Date,
    default: Date.now
  },
  passwordResetToken: String,
  passwordResetExpires: Date,
  resetToken: String,
  resetTokenExpiry: Date
}, { timestamps: true });

const configSchema = new mongoose.Schema({
  requiredCredits: {
    type: Number,
    default: 95,
    min: 0,
    max: 140
  },
  maintenanceMode: {
    type: Boolean,
    default: false
  }
});

const Config = mongoose.model('Config', configSchema);

// Initialize config
const initializeConfig = async () => {
  const config = await Config.findOne();
  if (!config) {
    await new Config().save();
  }
};

// Password Reset Routes
app.post("/api/forgot-password", async (req, res) => {
  const { email } = req.body;

  const student = await Student.findOne({ email });
  if (!student) return res.status(404).json({ message: "No student with this email" });

  const token = crypto.randomBytes(32).toString("hex");
  student.resetToken = token;
  student.resetTokenExpiry = Date.now() + 3600000; // 1 hour
  await student.save();

  const transporter = nodemailer.createTransporter({
    service: 'gmail',
    auth: {
      user: "capstoneserverewu@gmail.com",
      pass: "ppry snhj xcuc zfdc", 
    },
  });

  const resetLink = `${process.env.REACT_APP_API_URL}/reset-pass/${token}`;

  await transporter.sendMail({
    from: "capstoneserverewu@gmail.com",
    to: student.email,
    subject: "Reset Your Password",
    html: `<p>Click <a href="${resetLink}">here</a> to reset your password. This link will expire in 1 hour.</p>`
  });

  res.json({ message: "Reset email sent successfully" });
});

app.post("/api/reset-pass/:token", async (req, res) => {
  const { token } = req.params;
  const { password } = req.body;

  const student = await Student.findOne({
    resetToken: token,
    resetTokenExpiry: { $gt: Date.now() },
  });

  if (!student) return res.status(400).json({ message: "Invalid or expired token" });

  student.password = await bcrypt.hash(password, 10);
  student.resetToken = undefined;
  student.resetTokenExpiry = undefined;
  await student.save();

  res.json({ message: "Password reset successful" });
});

app.post("/api/forgot-password/faculty", async (req, res) => {
  const { email } = req.body;

  const faculty = await Faculty.findOne({ email });
  if (!faculty) return res.status(404).json({ message: "No Faculty with this email" });

  const token = crypto.randomBytes(32).toString("hex");
  faculty.resetToken = token;
  faculty.resetTokenExpiry = Date.now() + 3600000; // 1 hour
  await faculty.save();

  const transporter = nodemailer.createTransporter({
    service: 'gmail',
    auth: {
      user: "capstoneserverewu@gmail.com",
      pass: "ppry snhj xcuc zfdc", 
    },
  });

  const resetLink = `${process.env.REACT_APP_API_URL}/reset-pass/faculty/${token}`;

  await transporter.sendMail({
    from: "capstoneserverewu@gmail.com",
    to: faculty.email,
    subject: "Reset Your Password",
    html: `<p>Click <a href="${resetLink}">here</a> to reset your password. This link will expire in 1 hour.</p>`
  });

  res.json({ message: "Reset email sent successfully" });
});

app.post("/api/reset-pass/faculty/:token", async (req, res) => {
  const { token } = req.params;
  const { password } = req.body;

  const faculty = await Faculty.findOne({
    resetToken: token,
    resetTokenExpiry: { $gt: Date.now() },
  });

  if (!faculty) return res.status(400).json({ message: "Invalid or expired token" });

  faculty.password = await bcrypt.hash(password, 10);
  faculty.resetToken = undefined;
  faculty.resetTokenExpiry = undefined;
  await faculty.save();

  res.json({ message: "Password reset successful" });
});

const Admin = mongoose.model('Admin', adminSchema);
const ActivationRequest = mongoose.model('ActivationRequest', activationRequestSchema);
const Student = mongoose.model('Student', studentSchema);
const Faculty = mongoose.model('Faculty', facultySchema);

// Create admin 
const createAdmin = async () => {
  try {
    const existingAdmin = await Admin.findOne({ username: ADMIN_USERNAME });
    
    if (!existingAdmin) {
      const hashedPassword = await bcrypt.hash(ADMIN_PASSWORD, saltRounds);
      const admin = new Admin({
        username: ADMIN_USERNAME,
        password: hashedPassword
      });
      await admin.save();
      console.log('Admin account created from environment variables');
    }
  } catch (err) {
    console.error('Error initializing admin:', err);
    process.exit(1);
  }
};

// Authentication middleware
const authenticate = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Access denied' });

  try {
    const verified = jwt.verify(token, JWT_SECRET);
    req.user = verified;

    if (req.user.role === 'student') {
      const config = await Config.findOne();
      const student = await Student.findById(req.user.id);
      
      if (!student) return res.status(404).json({ message: 'Student not found' });
      if (student.completedCredits < config.requiredCredits) {
        return res.status(403).json({ 
          message: `Credit requirement increased. You need ${config.requiredCredits} credits.` 
        });
      }
    }

    next();
  } catch (err) {
    res.status(400).json({ message: 'Invalid token' });
  }
};

// Admin Routes
app.post('/api/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const admin = await Admin.findOne({ username });

    if (!admin) return res.status(400).json({ message: 'Invalid credentials' });

    const validPass = await bcrypt.compare(password, admin.password);
    if (!validPass) return res.status(400).json({ message: 'Invalid credentials' });

    const token = jwt.sign({ id: admin._id }, JWT_SECRET, { expiresIn: '1h' });
    res.json({ token });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Faculty Routes
app.post('/api/faculty/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    console.log("Login attempt for:", email);

    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }

    const faculty = await Faculty.findOne({ email });
    
    if (!faculty) {
      console.log("Faculty not found:", email);
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    const validPassword = await bcrypt.compare(password, faculty.password);
    
    if (!validPassword) {
      console.log("Invalid password for:", email);
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    if (faculty.status !== 'Active') {
      console.log("Inactive account attempt:", email);
      return res.status(403).json({ message: 'Account is not active' });
    }

    const token = jwt.sign(
      { id: faculty._id, role: 'faculty' }, 
      JWT_SECRET, 
      { expiresIn: '1h' }
    );

    console.log("Login successful for:", email);
    res.json({ token });

  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ message: 'Server error' });
  }
});


app.put('/api/faculty/toggle-visibility', authenticate, async (req, res) => {
  try {
    const { visibleToStudents } = req.body;
    
    if (typeof visibleToStudents !== 'boolean') {
      return res.status(400).json({ 
        message: 'visibleToStudents must be a boolean value' 
      });
    }

    const updatedFaculty = await Faculty.findByIdAndUpdate(
      req.user.id,
      { visibleToStudents },
      { new: true, select: '-password' }
    );

    if (!updatedFaculty) {
      return res.status(404).json({ message: 'Faculty not found' });
    }

    console.log(`Faculty visibility updated: ${updatedFaculty.email} - visible: ${visibleToStudents}`);
    
    res.json({ 
      success: true, 
      message: `Profile ${visibleToStudents ? 'is now visible to' : 'is now hidden from'} students`,
      visibleToStudents: updatedFaculty.visibleToStudents
    });
  } catch (error) {
    console.error('Toggle visibility error:', error);
    res.status(500).json({ message: 'Server error while updating visibility' });
  }
});

// ✅ NEW ENDPOINT: Get visible faculty for students
app.get('/api/faculty/visible', authenticate, async (req, res) => {
  try {
    // Verify the requester is a student
    if (req.user.role !== 'student') {
      return res.status(403).json({ message: 'Access denied: Students only' });
    }

    const visibleFaculty = await Faculty.find({
      status: 'Active',
      visibleToStudents: true
    }).select('-password -resetToken -resetTokenExpiry');

    res.json(visibleFaculty);
  } catch (err) {
    console.error('Error fetching visible faculty:', err);
    res.status(500).json({ message: 'Server error' });
  }
});


// ✅ MIGRATION ENDPOINT (run once to set default visibility for existing faculty)
app.post('/api/admin/migrate-faculty-visibility', authenticate, async (req, res) => {
  try {
    const result = await Faculty.updateMany(
      { visibleToStudents: { $exists: false } },
      { $set: { visibleToStudents: true } }
    );
    
    res.json({ 
      success: true, 
      message: `Updated ${result.modifiedCount} faculty records with default visibility` 
    });
  } catch (error) {
    res.status(500).json({ message: 'Migration failed', error: error.message });
  }
});
app.post('/api/faculty', authenticate, async (req, res) => {
  try {
    const { name, email, department, role } = req.body;
    
    if (!DEFAULT_FACULTY_PASSWORD) {
      return res.status(500).json({ 
        message: 'Server misconfiguration: Faculty password not set' 
      });
    }

    const existingFaculty = await Faculty.findOne({ email });
    if (existingFaculty) {
      return res.status(400).json({ 
        message: 'Faculty with this email already exists' 
      });
    }

    const hashedPassword = await bcrypt.hash(DEFAULT_FACULTY_PASSWORD, saltRounds);

    const newFaculty = new Faculty({
      name,
      email,
      department,
      role: role || 'Professor',
      password: hashedPassword,
      status: 'Active'
    });

    await newFaculty.save();
    res.status(201).json(newFaculty);
  } catch (err) {
    res.status(400).json({ 
      message: err.message.includes('duplicate') 
        ? 'Email already exists' 
        : 'Validation error' 
    });
  }
});

app.post('/api/faculty/import', async (req, res) => {
  try {
    const { faculty } = req.body;

    if (!DEFAULT_FACULTY_PASSWORD) {
      return res.status(500).json({ 
        success: false,
        message: 'Server misconfiguration: Default faculty password not set'
      });
    }

    if (!Array.isArray(faculty) || faculty.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid request format: Expected array of faculty data'
      });
    }

    const hashedPassword = await bcrypt.hash(DEFAULT_FACULTY_PASSWORD, 10);
    const errors = [];
    const validEntries = [];
    const skippedEntries = [];

    for (const [index, entry] of faculty.entries()) {
      const rowNumber = index + 1;
      
      try {
        if (!entry.name || !entry.email || !entry.department) {
          throw new Error('Missing required fields (name, email, department)');
        }

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry.email)) {
          throw new Error('Invalid email format');
        }

        const exists = await Faculty.findOne({ email: entry.email });
        if (exists) {
          throw new Error('Email already exists');
        }

        validEntries.push({
          name: entry.name.trim(),
          email: entry.email.toLowerCase().trim(),
          department: entry.department.trim(),
          password: hashedPassword,
          status: entry.status || 'Active',
          role: entry.role,
          phone: entry.phone?.trim() || '',
          office: entry.office?.trim() || '',
          joined: entry.joined ? new Date(entry.joined) : new Date()
        });

      } catch (error) {
        skippedEntries.push({
          row: rowNumber,
          email: entry.email,
          error: error.message
        });
      }
    }

    const createdFaculty = await Faculty.insertMany(validEntries, { ordered: false });

    const response = {
      success: true,
      imported: createdFaculty.length,
      skipped: skippedEntries.length,
      details: {
        skippedEntries,
        validationErrors: errors
      },
      faculty: createdFaculty
    };

    if (skippedEntries.length > 0) {
      response.message = `Imported ${createdFaculty.length} of ${faculty.length} faculty members`;
    }

    res.json(response);

  } catch (error) {
    console.error('Faculty import error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Internal server error during faculty import'
    });
  }
});

app.put('/api/faculty/change-password', authenticate, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const facultyId = req.user.id;

    // Validation
    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Current password and new password are required',
        field: !currentPassword ? 'currentPassword' : 'newPassword'
      });
    }

    // Password strength validation
    if (newPassword.length < 8) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 8 characters long',
        field: 'newPassword'
      });
    }

    if (!/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/.test(newPassword)) {
      return res.status(400).json({
        success: false,
        message: 'Password must contain uppercase, lowercase, and number',
        field: 'newPassword'
      });
    }

    // Find faculty
    const faculty = await Faculty.findById(facultyId);
    if (!faculty) {
      return res.status(404).json({
        success: false,
        message: 'Faculty not found'
      });
    }

    // Verify current password
    const isCurrentPasswordValid = await bcrypt.compare(currentPassword, faculty.password);
    if (!isCurrentPasswordValid) {
      return res.status(400).json({
        success: false,
        message: 'Current password is incorrect',
        field: 'currentPassword'
      });
    }

    // Check if new password is same as current
    const isSamePassword = await bcrypt.compare(newPassword, faculty.password);
    if (isSamePassword) {
      return res.status(400).json({
        success: false,
        message: 'New password must be different from current password',
        field: 'newPassword'
      });
    }

    // Hash new password
    const saltRounds = 12;
    const hashedNewPassword = await bcrypt.hash(newPassword, saltRounds);

    // Update password
    await Faculty.findByIdAndUpdate(facultyId, {
      password: hashedNewPassword,
      passwordChangedAt: new Date()
    });

    console.log(`Password changed for faculty: ${faculty.email}`);

    res.json({
      success: true,
      message: 'Password changed successfully'
    });

  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while changing password'
    });
  }
});

app.delete('/api/faculty/bulk', authenticate, async (req, res) => {
  try {
    const { ids } = req.body;
    await Faculty.deleteMany({ _id: { $in: ids } });
    const faculty = await Faculty.find();
    res.json(faculty);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

app.put('/api/faculty/bulk-status', authenticate, async (req, res) => {
  try {
    const { ids, status } = req.body;
    
    if (!Array.isArray(ids) || ids.length === 0 || !status) {
      return res.status(400).json({ message: 'Invalid request body' });
    }

    const objectIds = ids.map(id => new mongoose.Types.ObjectId(id));

    const result = await Faculty.updateMany(
      { _id: { $in: objectIds } },
      { $set: { status } }
    );

    if (result.modifiedCount === 0) {
      return res.status(404).json({ message: 'No matching faculty found' });
    }

    const updatedFaculty = await Faculty.find();
    res.json(updatedFaculty);
  } catch (err) {
    console.error('Bulk status error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

app.get('/api/faculty', authenticate, async (req, res) => {
  try {
    const faculty = await Faculty.find();
    res.json(faculty);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});



app.get('/api/faculty/me', authenticate, async (req, res) => {
  const faculty = await Faculty.findById(req.user.id).select('-password');
  if (!faculty) return res.status(404).json({ message: 'Faculty not found' });
  res.json(faculty);
});

app.put('/api/faculty/me', authenticate, async (req, res) => {
  try {
    const { name, phone, profilePicture } = req.body;
    const updateData = {};
    const errors = [];

    // Validate name
    if (name !== undefined) {
      if (!name || name.trim().length < 2) {
        errors.push({ field: 'name', message: 'Name must be at least 2 characters long' });
      } else if (name.trim().length > 50) {
        errors.push({ field: 'name', message: 'Name cannot exceed 50 characters' });
      } else if (!/^[a-zA-Z\s.'-]+$/.test(name.trim())) {
        errors.push({ field: 'name', message: 'Name can only contain letters, spaces, periods, apostrophes, and hyphens' });
      } else {
        updateData.name = name.trim();
      }
    }

    // Validate phone
    if (phone !== undefined && phone.trim()) {
      // Clean the phone number by removing all spaces, dashes, and special characters except +
      const cleanPhone = phone.replace(/[\s\-\(\)\.]/g, "");

      // More flexible patterns for Bangladeshi numbers
      const validPatterns = [
        /^\+8801[3-9]\d{8}$/, // +8801XXXXXXXX
        /^8801[3-9]\d{8}$/, // 8801XXXXXXXX
        /^01[3-9]\d{8}$/, // 01XXXXXXXX
      ];

      const isValidPhone = validPatterns.some((pattern) =>
        pattern.test(cleanPhone)
      );

      if (!isValidPhone) {
        errors.push({
          field: "phone",
          message:
            "Please enter a valid Bangladeshi mobile number (e.g., +880 1712345678)",
        });
      } else {
        // Normalize phone number format before saving
        let normalizedPhone = cleanPhone;
        if (normalizedPhone.startsWith("0")) {
          normalizedPhone = "+880" + normalizedPhone.substring(1);
        } else if (normalizedPhone.startsWith("880")) {
          normalizedPhone = "+" + normalizedPhone;
        } else if (!normalizedPhone.startsWith("+880")) {
          normalizedPhone = "+880" + normalizedPhone;
        }
        updateData.phone = normalizedPhone;
      }
    } else if (phone === "") {
      // Allow clearing phone number
      updateData.phone = "";
    }

    // Validate and handle profilePicture
    if (profilePicture !== undefined) {
      if (profilePicture === null || profilePicture === "") {
        updateData.profilePicture = null; // Remove profile picture
      } else if (typeof profilePicture === 'string' && profilePicture.startsWith('data:image/')) {
        // Validate base64 image size (5MB limit)
        const sizeInBytes = (profilePicture.length * 3) / 4;
        if (sizeInBytes > 5 * 1024 * 1024) {
          errors.push({
            field: 'profilePicture',
            message: 'Image size exceeds 5MB limit'
          });
        } else {
          updateData.profilePicture = profilePicture;
        }
      } else {
        errors.push({
          field: 'profilePicture',
          message: 'Invalid image format'
        });
      }
    }


    // Return validation errors
    if (errors.length > 0) {
      return res.status(400).json({ 
        message: 'Validation failed',
        errors: errors 
      });
    }

    // Check if there are any updates to make
    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ 
        message: 'No valid updates provided' 
      });
    }

    // Update the faculty record
    const updatedFaculty = await Faculty.findByIdAndUpdate(
      req.user.id,
      updateData,
      { 
        new: true, 
        runValidators: true,
        select: '-password' // Don't return password
      }
    );

    if (!updatedFaculty) {
      return res.status(404).json({ message: "Faculty not found" });
    }

    console.log(`Faculty profile updated: ${updatedFaculty.email} - ${updatedFaculty.name}`);

    res.json(updatedFaculty);

  } catch (err) {
    console.error("Profile update error:", err);
    
    // Handle mongoose validation errors
    if (err.name === 'ValidationError') {
      const validationErrors = Object.values(err.errors).map(e => ({
        field: e.path,
        message: e.message
      }));
      
      return res.status(400).json({ 
        message: 'Validation failed',
        errors: validationErrors 
      });
    }
    
    // Handle duplicate key errors
    if (err.code === 11000) {
      const field = Object.keys(err.keyPattern)[0];
      return res.status(409).json({ 
        message: `${field} already exists. Please use a different value.` 
      });
    }

    res.status(500).json({ message: "Internal server error" });
  }
});


app.put('/api/faculty/:id', authenticate, async (req, res) => {
  try {
    const faculty = await Faculty.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json(faculty);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

app.delete('/api/faculty/:id', authenticate, async (req, res) => {
  try {
    await Faculty.findByIdAndDelete(req.params.id);
    res.json({ message: 'Faculty deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});



// Student Routes
app.post('/api/students', authenticate, async (req, res) => {
  try {
    const { studentId, name, email, phone, address, completedCredits } = req.body;

    if (!studentId || !name || !email) {
      return res.status(400).json({ message: 'Missing required fields: studentId, name, and email are required' });
    }

    if (!/^\d{4}-\d-\d{2}-\d{3}$/.test(studentId)) {
      return res.status(400).json({ message: 'Invalid student ID format. Use XXXX-X-XX-XXX format' });
    }

    const program = getProgramFromStudentId(studentId);
    if (program === 'Undecided') {
      return res.status(400).json({ message: 'Could not determine program from student ID' });
    }

    const existingStudent = await Student.findOne({ $or: [{ studentId }, { email }] });
    if (existingStudent) {
      return res.status(400).json({ message: 'Student with this ID or email already exists' });
    }

    const hashedPassword = await bcrypt.hash(DEFAULT_STUDENT_PASSWORD, saltRounds);
    
    const student = new Student({
      studentId,
      name,
      email,
      program,
      password: hashedPassword,
      status: 'Active',
      phone: phone || '',
      address: address || '',
      completedCredits: completedCredits || 0,
      cgpa: 0.0
    });

    await student.save();
    res.status(201).json({
      message: 'Student created successfully',
      student: {
        _id: student._id,
        studentId: student.studentId,
        name: student.name,
        email: student.email,
        program: student.program,
        status: student.status
      }
    });
  } catch (err) {
    console.error('Error creating student:', err);
    res.status(500).json({ 
      message: 'Error creating student',
      error: err.message
    });
  }
});

app.put('/api/students/bulk-status', authenticate, async (req, res) => {
  try {
    const { ids, status } = req.body;
    if (!Array.isArray(ids) || !ids.length || !['Active','Inactive','Probation','Graduated'].includes(status)) {
      return res.status(400).json({ message: 'Invalid request' });
    }

    const objectIds = ids.map(id => new mongoose.Types.ObjectId(id));
    await Student.updateMany(
      { _id: { $in: objectIds } },
      { $set: { status } }
    );
    const updatedStudents = await Student.find({ _id: { $in: objectIds } }).select('-password');
    return res.json(updatedStudents);
  } catch (err) {
    console.error('Bulk status error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});



app.get('/api/students', authenticate, async (req, res) => {
  try {
    const { status, excludeInactive } = req.query;
    
    let filter = {};
    
    if (status) {
      filter.status = status;
    }
    
    if (excludeInactive === 'true') {
      filter.status = { $ne: 'Inactive' };
    }
    
    const students = await Student.find(filter).select('-password');
    res.json(students);
  } catch (err) {
    console.error('Error fetching students:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/students/import', authenticate, async (req, res) => {
  try {
    const { students } = req.body;
    
    const hashedPassword = await bcrypt.hash(DEFAULT_STUDENT_PASSWORD, saltRounds);

    const results = {
      total: students.length,
      importedCount: 0,
      errors: []
    };

    const bulkOperations = [];
    const seenIds = new Set();

    students.forEach((student, index) => {
      try {
        if (!student.studentId || student.completedCredits === undefined) {
          throw new Error('Missing required fields: Student ID and Completed Credits');
        }

        if (!/^\d{4}-\d-\d{2}-\d{3}$/.test(student.studentId)) {
          throw new Error('Invalid Student ID format (XXXX-X-XX-XXX)');
        }

        if (seenIds.has(student.studentId)) {
          throw new Error('Duplicate Student ID in import file');
        }
        seenIds.add(student.studentId);

        if (typeof student.completedCredits !== 'number' || 
            student.completedCredits < 0 || 
            student.completedCredits >140) {
          throw new Error('Completed Credits must be a number between 0-140');
        }

        if (student.cgpa && (student.cgpa < 0 || student.cgpa > 4)) {
          throw new Error('CGPA must be between 0-4');
        }

        const studentData = {
          ...student,
          password: hashedPassword,
          program: getProgramFromStudentId(student.studentId),
          email: student.email || `${student.studentId}@std.ewubd.edu`,
          status: student.status || 'Active'
        };

        bulkOperations.push({
          updateOne: {
            filter: { studentId: studentData.studentId },
            update: {
              $setOnInsert: studentData
            },
            upsert: true
          }
        });

      } catch (error) {
        results.errors.push(`Row ${index + 1}: ${error.message}`);
      }
    });

    const bulkResult = await Student.bulkWrite(bulkOperations, { ordered: false });
    results.importedCount = bulkResult.upsertedCount;

    res.json({
      success: true,
      ...results,
      message: `Imported ${results.importedCount} students with default password`
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message
    });
  }
});

app.get('/api/admin/check-auth', authenticate, (req, res) => {
  res.json({ authenticated: true });
});

app.get('/api/config', authenticate, async (req, res) => {
  try {
    const config = await Config.findOne();
    res.json(config || { requiredCredits: 95 });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

app.put('/api/config', authenticate, async (req, res) => {
  try {
    const { requiredCredits } = req.body;
    
    if (typeof requiredCredits !== 'number' || requiredCredits < 0 || requiredCredits > 140) {
      return res.status(400).json({ message: 'Invalid credit value' });
    }

    const config = await Config.findOneAndUpdate(
      {},
      { requiredCredits },
      { new: true, upsert: true }
    );
    res.json(config);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

app.put('/api/config/maintenance', authenticate, async (req, res) => {
  try {
    const { maintenanceMode } = req.body;
    
    const config = await Config.findOneAndUpdate(
      {},
      { maintenanceMode },
      { new: true, upsert: true }
    );
    res.json(config);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/students/login', async (req, res) => {
  try {
    const config = await Config.findOne();
    if (config?.maintenanceMode) {
      return res.status(503).json({ 
        message: 'System is under maintenance. Please try again later.' 
      });
    }

    const { studentId, password } = req.body;
    
    if (!studentId || !password) {
      return res.status(400).json({ message: 'Student ID and password are required' });
    }

    const student = await Student.findOne({ studentId }).select('+password');
    if (!student) {
      return res.status(401).json({ message: 'Student ID is not registered' });
    }

    const validPassword = await bcrypt.compare(password, student.password);
    if (!validPassword) {
      return res.status(401).json({ message: 'Wrong password' });
    }

    if (student.status !== 'Active') {
      return res.status(403).json({ 
        message: `Account is ${student.status}. Contact administration for assistance.`
      });
    }

    const requiredCredits = config?.requiredCredits || 95;

    if (student.completedCredits < requiredCredits) {
      return res.status(403).json({ 
        message: `You need at least ${requiredCredits} completed credits to login` 
      });
    }

    // FIXED: Include role in JWT token
    const token = jwt.sign({ id: student._id, role: 'student' }, JWT_SECRET, { expiresIn: '1h' });
    res.json({ 
      token,
      student: {
        _id: student._id,
        name: student.name,
        studentId: student.studentId,
        completedCredits: student.completedCredits,
        cgpa: student.cgpa,
        program: student.program,
        email: student.email
      }
    });
    
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});


// Password change endpoint
// Password change endpoint
app.put('/api/students/change-password', authenticate, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const studentId = req.user.id;

    // Validation
    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Current password and new password are required',
        field: !currentPassword ? 'currentPassword' : 'newPassword'
      });
    }

    // Password strength validation
    if (newPassword.length < 8) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 8 characters long',
        field: 'newPassword'
      });
    }

    if (!/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/.test(newPassword)) {
      return res.status(400).json({
        success: false,
        message: 'Password must contain at least one uppercase letter, one lowercase letter, and one number',
        field: 'newPassword'
      });
    }

    // Find student
    const student = await Student.findById(studentId);
    if (!student) {
      return res.status(404).json({
        success: false,
        message: 'Student not found'
      });
    }

    // Verify current password
    const isCurrentPasswordValid = await bcrypt.compare(currentPassword, student.password);
    if (!isCurrentPasswordValid) {
      return res.status(400).json({
        success: false,
        message: 'Current password is incorrect',
        field: 'currentPassword'
      });
    }

    // Check if new password is same as current
    const isSamePassword = await bcrypt.compare(newPassword, student.password);
    if (isSamePassword) {
      return res.status(400).json({
        success: false,
        message: 'New password must be different from current password',
        field: 'newPassword'
      });
    }

    // Hash new password
    const saltRounds = 12;
    const hashedNewPassword = await bcrypt.hash(newPassword, saltRounds);

    // Update password
    await Student.findByIdAndUpdate(studentId, {
      password: hashedNewPassword,
      passwordChangedAt: new Date()
    });

    console.log(`Password changed for student: ${student.studentId}`);

    res.json({
      success: true,
      message: 'Password changed successfully'
    });

  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while changing password'
    });
  }
});

app.put('/api/students/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    if (updates.studentId && !/^\d{4}-\d-\d{2}-\d{3}$/.test(updates.studentId)) {
      return res.status(400).json({ message: 'Invalid Student ID format' });
    }

    if (updates.studentId) {
      const existingStudent = await Student.findOne({ 
        studentId: updates.studentId,
        _id: { $ne: id }
      });
      if (existingStudent) {
        return res.status(400).json({ message: 'Student ID already exists' });
      }
    }

    const student = await Student.findByIdAndUpdate(
      id,
      updates,
      { new: true, runValidators: true }
    ).select('-password');

    if (!student) return res.status(404).json({ message: 'Student not found' });
    
    res.json(student); 

  } catch (err) {
    console.error('Update error:', err);
    
    if (err.name === 'ValidationError') {
      const errors = Object.values(err.errors).map(e => e.message);
      return res.status(400).json({ 
        message: 'Validation error',
        errors 
      });
    }
    
    res.status(500).json({ 
      message: 'Server error',
      error: err.message 
    });
  }
});
// Update this endpoint in server.js
// Update this endpoint in server.js
app.get('/api/students/me', authenticate, async (req, res) => {
  try {
    const student = await Student.findById(req.user.id)
      .select('name studentId email program completedCredits cgpa phone address enrolled avatar'); // ADDED avatar
    
    if (!student) {
      return res.status(404).json({ message: 'Student not found' });
    }

    const [firstName, ...lastNameParts] = student.name.split(' ');
    const lastName = lastNameParts.join(' ');

    const response = {
      firstName,
      lastName,
      name: student.name,
      studentId: student.studentId,
      email: student.email,
      program: student.program,
      completedCredits: student.completedCredits,
      cgpa: student.cgpa,
      phone: student.phone || '',
      address: student.address || '',
      enrolled: student.enrolled,
      avatar: student.avatar, // INCLUDE avatar
      avatarUrl: student.avatar // For compatibility
    };

    res.json(response);
  } catch (err) {
    console.error('Error fetching student profile:', err);
    res.status(500).json({ message: 'Server error' });
  }
});


// Updated Avatar Upload Endpoint - Base64 Support
// Replace the broken avatar upload endpoint in server.js
app.post('/api/students/avatar', authenticate, async (req, res) => {
  try {
    const { avatar } = req.body;
    
    if (!avatar) {
      return res.status(400).json({ message: 'No avatar data provided' });
    }

    // Validate base64 format
    if (!avatar.startsWith('data:image/')) {
      return res.status(400).json({ message: 'Invalid image format' });
    }

    // Check file size (base64 encoded, so roughly 1.37x larger than original)
    const sizeInBytes = (avatar.length * 3) / 4;
    if (sizeInBytes > 5 * 1024 * 1024) { // 5MB limit
      return res.status(400).json({ message: 'Image size exceeds 5MB limit' });
    }

    // Update student with base64 avatar
    const updatedStudent = await Student.findByIdAndUpdate(
      req.user.id,
      { avatar: avatar },
      { new: true }
    ).select('-password');

    if (!updatedStudent) {
      return res.status(404).json({ message: 'Student not found' });
    }

    console.log('Avatar updated successfully for student:', req.user.id);

    res.status(200).json({
      message: 'Avatar updated successfully',
      fileId: updatedStudent._id,
      avatarUrl: avatar
    });

  } catch (error) {
    console.error('Avatar upload error:', error);
    res.status(500).json({ message: 'Server error during avatar upload' });
  }
});


// Get avatar by student ID
app.get('/api/students/avatar/:id', async (req, res) => {
  try {
    const student = await Student.findById(req.params.id).select('avatar');
    
    if (!student || !student.avatar) {
      return res.status(404).json({ message: 'Avatar not found' });
    }

    // Extract base64 data and content type
    const matches = student.avatar.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    if (!matches) {
      return res.status(400).json({ message: 'Invalid avatar format' });
    }

    const contentType = matches[1];
    const base64Data = matches[2];
    const buffer = Buffer.from(base64Data, 'base64');

    res.set('Content-Type', contentType);
    res.send(buffer);

  } catch (err) {
    console.error('Avatar fetch error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

app.delete('/api/students/bulk', authenticate, async (req, res) => {
  try {
    const { ids } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: 'No IDs provided' });
    }

    const validIds = ids.filter(id => mongoose.Types.ObjectId.isValid(id));

    if (validIds.length === 0) {
      return res.status(400).json({ message: 'No valid IDs provided' });
    }

    const result = await Student.deleteMany({ _id: { $in: validIds } });

    res.json({
      deletedCount: result.deletedCount,
      invalidEntries: ids.length - validIds.length,
    });

  } catch (err) {
    console.error('Bulk delete error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

app.delete('/api/students/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    
    const deletedStudent = await Student.findByIdAndDelete(id);
    
    if (!deletedStudent) {
      return res.status(404).json({ message: 'Student not found' });
    }

    res.json({ message: 'Student deleted successfully' });
  } catch (err) {
    console.error('Error deleting student:', err);
    res.status(500).json({ message: 'Server error during deletion' });
  }
});

// Team Request Schema
const teamRequestSchema = new mongoose.Schema({
  teamName: { type: String, required: true },
  teamData: {
    name: { type: String, required: true },
    major: String,
    semester: String,
    projectIdea: String,
    capstone: String,
    description: String
  },
  senderStudentId: { type: String, required: true },
  senderName: { type: String, required: true },
  senderEmail: String,
  senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
  targetStudentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
  targetStudentEmail: String,
  targetStudentName: String,
  message: String,
  status: { 
    type: String, 
    enum: ['pending', 'accepted', 'rejected'], 
    default: 'pending' 
  },
  sentDate: { type: Date, default: Date.now },
  responseDate: Date
}, { timestamps: true });

// Updated Team Schema
const teamSchema = new mongoose.Schema({
  name: { type: String, required: true },
  major: String,
  semester: String,
  projectIdea: String,
  capstone: { type: String, default: 'A' },
  description: String,
  maxMembers: { type: Number, default: 4 }, // 4 members maximum
  memberCount: { type: Number, default: 1 },
  
  members: [{
    studentId: { type: String, required: true },
    name: { type: String, required: true },
    email: String,
    program: String,
    role: { type: String, enum: ['Leader', 'Member'], default: 'Member' },
    joinedDate: { type: Date, default: Date.now }
  }],
  
  status: { 
    type: String, 
    enum: ['active', 'recruiting', 'inactive'], 
    default: 'recruiting' 
  },
  phase: { type: String, default: 'A' },
  currentPhase: { type: String, default: 'A' },
  
  joinRequests: [{
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
    studentName: { type: String, required: true },
    message: String,
    avatar: String, // Base64 avatar data
      studentName: { type: String, required: true },
  studentIdNumber: { type: String },
  completedCredits: { type: Number },
  program: { type: String },
    status: { type: String, enum: ['pending', 'accepted', 'rejected'], default: 'pending' },
    requestDate: { type: Date, default: Date.now }
  }],

  createdDate: { type: Date, default: Date.now },
  supervisor: { type: mongoose.Schema.Types.ObjectId, ref: 'Faculty' }
}, { timestamps: true });


const TeamRequest = mongoose.model('TeamRequest', teamRequestSchema);
const Team = mongoose.model('Team', teamSchema);

// Team API Endpoints

// Send team invitation
// Enhanced send team invitation with duplicate prevention and notifications
app.post('/api/teams/send-request', authenticate, async (req, res) => {
  try {
    const {
      teamName,
      teamData,
      targetStudentId,
      targetStudentName,
      targetStudentEmail,
      message
    } = req.body;

    const sender = await Student.findById(req.user.id);
    if (!sender) {
      return res.status(404).json({ message: 'Sender not found' });
    }

    // Check if sender is already in ANY team
    const senderExistingTeam = await Team.findOne({
      'members.studentId': sender.studentId
    });
    if (senderExistingTeam) {
      return res.status(403).json({ 
        message: 'You cannot create team requests while already in a team',
        teamName: senderExistingTeam.name,
        action: 'redirect_to_my_team'
      });
    }

    const targetStudent = await Student.findById(targetStudentId);
    if (!targetStudent) {
      return res.status(404).json({ message: 'Target student not found' });
    }

    // Check if target student is already in a team
    const targetExistingTeam = await Team.findOne({
      'members.studentId': targetStudent.studentId
    });
    if (targetExistingTeam) {
      return res.status(400).json({ 
        message: `${targetStudent.name} is already in team "${targetExistingTeam.name}"` 
      });
    }

    // ENHANCED: Check for existing pending requests with detailed response
    const existingRequest = await TeamRequest.findOne({
      senderId: req.user.id,
      targetStudentId: targetStudentId,
      status: 'pending'
    });
    
    if (existingRequest) {
      return res.status(400).json({ 
        message: `You have already sent a team request to ${targetStudent.name}. Wait for their confirmation.`,
        action: 'duplicate_request',
        existingRequestId: existingRequest._id,
        sentDate: existingRequest.sentDate
      });
    }

    // Create new team request
    const teamRequest = new TeamRequest({
      teamName,
      teamData,
      senderStudentId: sender.studentId,
      senderName: sender.name,
      senderEmail: sender.email,
      senderId: req.user.id,
      targetStudentId: targetStudentId,
      targetStudentEmail: targetStudentEmail,
      targetStudentName: targetStudentName,
      message: message || `${sender.name} has invited you to join team "${teamName}"`
    });

    await teamRequest.save();

    // ENHANCED: Create notification for target student
    await createTeamRequestNotification({
      recipientId: targetStudentId,
      senderName: sender.name,
      senderStudentId: sender.studentId,
      teamName: teamName,
      requestId: teamRequest._id,
      message: `${sender.name} sent you a request to create team "${teamName}"`
    });

    console.log(`Team request notification sent to ${targetStudent.name} from ${sender.name}`);

    res.json({
      success: true,
      message: 'Team invitation sent successfully',
      requestId: teamRequest._id,
      notificationSent: true
    });

  } catch (error) {
    console.error('Send request error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});



// Get incoming team requests for a student
app.get('/api/teams/requests/incoming', authenticate, async (req, res) => {
  try {
    console.log('Fetching incoming requests for user:', req.user.id);
    
    const requests = await TeamRequest.find({
      targetStudentId: req.user.id,
      status: 'pending'
    }).sort({ sentDate: -1 });

    console.log('Found incoming requests:', requests.length);
    res.json(requests);
  } catch (error) {
    console.error('Get incoming requests error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});


// Accept team request - Updated to show team in join page
app.post('/api/teams/accept-request', authenticate, async (req, res) => {
  try {
    const { requestId } = req.body;
    console.log('Accepting request:', requestId, 'by user:', req.user.id);

    const request = await TeamRequest.findById(requestId);
    if (!request) {
      console.log('Request not found:', requestId);
      return res.status(404).json({ message: 'Request not found' });
    }

    if (request.targetStudentId.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Unauthorized' });
    }

    if (request.status !== 'pending') {
      return res.status(400).json({ message: 'Request already processed' });
    }

    const currentStudent = await Student.findById(req.user.id);
    const existingTeam = await Team.findOne({
      'members.studentId': currentStudent.studentId
    });
    if (existingTeam) {
      return res.status(400).json({ message: 'You are already in a team' });
    }

    const sender = await Student.findById(request.senderId);
    if (!sender) {
      return res.status(404).json({ message: 'Team creator not found' });
    }

    // Check if sender is already in a team
    const senderExistingTeam = await Team.findOne({
      'members.studentId': sender.studentId
    });
    if (senderExistingTeam) {
      return res.status(400).json({ message: 'Team creator is already in another team' });
    }

    // Create new team with 2 members, can expand to 4
    const newTeam = new Team({
      name: request.teamData.name,
      major: request.teamData.major,
      semester: request.teamData.semester,
      projectIdea: request.teamData.projectIdea,
      capstone: request.teamData.capstone || 'A',
      description: request.teamData.description,
      members: [
        {
          studentId: sender.studentId,
          name: sender.name,
          email: sender.email,
          program: sender.program,
          role: 'Leader'
        },
        {
          studentId: currentStudent.studentId,
          name: currentStudent.name,
          email: currentStudent.email,
          program: currentStudent.program,
          role: 'Member'
        }
      ],
      status: 'recruiting', // Still recruiting for 2 more members
      memberCount: 2,
      maxMembers: 4,
      phase: 'A',
      currentPhase: 'A'
    });

    await newTeam.save();
    console.log('New team created:', newTeam._id);
const senderNotification = new Notification({
      recipientId: request.senderId,
      type: 'team_accepted',
      title: 'Team Request Accepted!',
      message: `${currentStudent.name} accepted your invitation to create team "${newTeam.name}"!`,
      data: {
        teamId: newTeam._id,
        teamName: newTeam.name,
        acceptedBy: currentStudent.name
      },
      read: false
    });
    
    await senderNotification.save();
    // Update request status
    request.status = 'accepted';
    request.responseDate = new Date();
    await request.save();

    // Remove any other pending requests from both students
    await TeamRequest.updateMany({
      $or: [
        { senderId: request.senderId, status: 'pending' },
        { targetStudentId: request.targetStudentId, status: 'pending' },
        { senderId: request.targetStudentId, status: 'pending' },
        { targetStudentId: request.senderId, status: 'pending' }
      ]
    }, { status: 'rejected' });

    console.log('Team request accepted successfully');
    res.json({
      success: true,
      message: 'Team request accepted successfully',
      team: newTeam
    });

  } catch (error) {
    console.error('Accept request error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Reject team request
app.post('/api/teams/reject-request', authenticate, async (req, res) => {
  try {
    const { requestId } = req.body;

    const request = await TeamRequest.findById(requestId);
    if (!request) {
      return res.status(404).json({ message: 'Request not found' });
    }

    if (request.targetStudentId.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Unauthorized' });
    }

    request.status = 'rejected';
    request.responseDate = new Date();
    await request.save();

    res.json({ success: true, message: 'Team request rejected' });

  } catch (error) {
    console.error('Reject request error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get all teams (for join team page) - Updated to show recruiting teams (1 member)
// Get all teams (for join team page) - Updated to show recruiting teams (1 member)
app.get('/api/teams/all', authenticate, async (req, res) => {
  try {
    // 1. Fetch all teams and convert to plain JS objects for modification
    const teams = await Team.find({
      status: { $in: ['recruiting', 'active'] }
    }).sort({ createdDate: -1 }).lean(); // Use .lean() for performance

    // 2. Collect all unique member student IDs from all teams
    const memberStudentIds = [...new Set(
      teams.flatMap(team => team.members.map(member => member.studentId))
    )];

    if (memberStudentIds.length > 0) {
      // 3. Fetch corresponding students with their avatars
      const studentsWithAvatars = await Student.find({
        studentId: { $in: memberStudentIds }
      }).select('studentId avatar');

      // 4. Create a map for efficient lookup (studentId -> avatar)
      const avatarMap = new Map(
        studentsWithAvatars.map(student => [student.studentId, student.avatar])
      );

      // 5. Inject the avatar into each member object in each team
      teams.forEach(team => {
        team.members.forEach(member => {
          member.avatar = avatarMap.get(member.studentId) || null;
          member.avatarUrl = member.avatar; // Add for frontend compatibility
        });
      });
    }
    
    console.log('Found and populated teams:', teams.length);
    res.json(teams);
  } catch (error) {
    console.error('Get teams error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});



// Get available students (not in any team) - Updated
// REPLACE the existing /api/students/available endpoint with this:
app.get('/api/students/available', authenticate, async (req, res) => {
  try {
    const currentStudentId = req.user.id;
    
    // ✅ FETCH DYNAMIC CONFIG
    const config = await Config.findOne();
    const requiredCredits = config?.requiredCredits || 95;
    
    console.log(`Using dynamic credit requirement: ${requiredCredits}`);
    
    // Find all student IDs that are already members of any team
    const teams = await Team.find({}, 'members.studentId');
    const memberStudentIds = teams.flatMap(team => 
      team.members.map(member => member.studentId)
    );

    // ✅ USE DYNAMIC CREDIT REQUIREMENT
    const availableStudents = await Student.find({
      _id: { $ne: currentStudentId },
      studentId: { $nin: memberStudentIds },
      status: 'Active',
      completedCredits: { $gte: requiredCredits } // ✅ Dynamic instead of hardcoded 90
    })
    .select('-password -resetToken -resetTokenExpiry')
    .sort({ name: 1 });

    console.log(`Found ${availableStudents.length} active students with ≥${requiredCredits} credits`);
    res.json(availableStudents);
  } catch (err) {
    console.error('Error fetching available students:', err);
    res.status(500).json({ message: 'Server error while fetching available students' });
  }
});



app.get('/api/students/:id', authenticate, async (req, res) => {
  try {
    const student = await Student.findById(req.params.id)
      .select('-password -resetToken -resetTokenExpiry');
    
    if (!student) {
      return res.status(404).json({ message: 'Student not found' });
    }
    
    res.json(student);
  } catch (err) {
    console.error('Error fetching student:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get my team
// Get my team
app.get('/api/teams/my-team', authenticate, async (req, res) => {
  try {
    const student = await Student.findById(req.user.id);
    if (!student) {
      return res.status(404).json({ message: 'Student not found' });
    }

    // 1. Fetch the team and convert to a plain JS object
    const team = await Team.findOne({
      'members.studentId': student.studentId
    }).lean(); // Use .lean() for performance

    if (!team) {
      return res.status(404).json({ message: 'No team found' });
    }

    // 2. Collect member student IDs from this specific team
    const memberStudentIds = team.members.map(member => member.studentId);

    // 3. Fetch corresponding students with their avatars
    const studentsWithAvatars = await Student.find({
      studentId: { $in: memberStudentIds }
    }).select('studentId avatar');

    // 4. Create a map for easy lookup
    const avatarMap = new Map(
      studentsWithAvatars.map(s => [s.studentId, s.avatar])
    );

    // 5. Inject avatar into each member object
    team.members.forEach(member => {
      member.avatar = avatarMap.get(member.studentId) || null;
      member.avatarUrl = member.avatar; // Add for frontend compatibility
    });

    res.json(team);
  } catch (error) {
    console.error('Get my team error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});
// Send join request to existing team
// Send join request to existing team - UPDATED
app.post('/api/teams/:teamId/join-request', authenticate, async (req, res) => {
  try {
    const { teamId } = req.params;
    const { message } = req.body;

    const team = await Team.findById(teamId);
    if (!team) {
      return res.status(404).json({ message: 'Team not found' });
    }

    const student = await Student.findById(req.user.id);
    if (!student) {
      return res.status(404).json({ message: 'Student not found' });
    }

    // Check if student is already in ANY team
    const existingTeam = await Team.findOne({
      'members.studentId': student.studentId
    });
    if (existingTeam) {
      return res.status(403).json({ 
        message: 'You cannot join another team while already in a team',
        currentTeam: existingTeam.name,
        action: 'redirect_to_my_team'
      });
    }

    const rejectionRecord = await TeamRejection.findOne({
      studentId: req.user.id,
      teamId: teamId
    });

    if (rejectionRecord && rejectionRecord.rejectionCount >= 3) {
      return res.status(403).json({ 
        message: `You have been rejected 3 times by team "${team.name}". No more requests allowed.`,
        action: 'rejection_limit_reached'
      });
    }

    // Check if team is full (4 members max)
    if (team.members.length >= 4) {
      return res.status(400).json({ 
        message: 'Team is full (4/4 members)',
        teamName: team.name,
        action: 'team_full'
      });
    }

    // Check if request already exists
    const existingRequest = team.joinRequests.find(
      req => req.studentId.toString() === student._id.toString() && req.status === 'pending'
    );
    if (existingRequest) {
      return res.status(400).json({ 
        message: 'Join request already sent',
        requestId: existingRequest._id 
      });
    }
    // UPDATED: Include additional student information
    team.joinRequests.push({
      studentId: student._id,
      studentName: student.name,
      studentIdNumber: student.studentId,        // ADD: Student ID
      completedCredits: student.completedCredits, // ADD: Completed Credits
      program: student.program,                   // ADD: Program
      avatar: student.avatar,                     // ADD: Avatar
      message: message || `${student.name} wants to join your team`,
      status: 'pending'
    });

    await team.save();

    res.json({ 
      success: true, 
      message: 'Join request sent successfully',
      request: team.joinRequests[team.joinRequests.length - 1]
    });

  } catch (error) {
    console.error('Join request error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});


// Handle join request
// Handle join request - FIXED VERSION
app.post('/api/teams/:teamId/handle-join-request', authenticate, async (req, res) => {
  try {
    const { teamId } = req.params;
    const { joinRequestId, status } = req.body;

    const team = await Team.findById(teamId);
    if (!team) {
      return res.status(404).json({ message: 'Team not found' });
    }

    // Check if the authenticated user is the team leader
    const leader = team.members.find(member => member.role === 'Leader');
    const student = await Student.findById(req.user.id);
    if (!leader || leader.studentId !== student.studentId) {
      return res.status(403).json({ message: 'Only the team leader can manage join requests' });
    }

    const joinRequest = team.joinRequests.id(joinRequestId);
    if (!joinRequest) {
      return res.status(404).json({ message: 'Join request not found' });
    }

    if (joinRequest.status !== 'pending') {
      return res.status(400).json({ message: 'Join request has already been processed' });
    }

    if (status === 'accepted') {
      // FIXED: Check for 4 members instead of 2
      if (team.members.length >= 4) {
        return res.status(400).json({ message: 'Team is already full (4/4 members)' });
      }

      const newMemberStudent = await Student.findById(joinRequest.studentId);
      if (!newMemberStudent) {
        return res.status(404).json({ message: 'Student to be added not found' });
      }

      // Check if student is already in another team
      const existingTeam = await Team.findOne({
        'members.studentId': newMemberStudent.studentId
      });
      if (existingTeam) {
        return res.status(400).json({ 
          message: `${newMemberStudent.name} is already in team "${existingTeam.name}"` 
        });
      }

      // Add new member
      team.members.push({
        studentId: newMemberStudent.studentId,
        name: newMemberStudent.name,
        email: newMemberStudent.email,
        program: newMemberStudent.program,
        role: 'Member'
      });
      
      // Update member count
      team.memberCount = team.members.length;
      
      // FIXED: Team becomes active when it has 4 members
      if (team.members.length >= 4) {
        team.status = 'active';
      } else {
        team.status = 'recruiting';
      }
      
      joinRequest.status = 'accepted';
      const acceptedStudent = await Student.findById(joinRequest.studentId);
      
      const notification = new Notification({
        recipientId: joinRequest.studentId,
        type: 'team_accepted', // Add this to your enum
        title: 'Team Request Accepted!',
        message: `Your request to join team "${team.name}" has been accepted!`,
        data: {
          teamId: team._id,
          teamName: team.name,
          acceptedBy: student.name,
          requestId: joinRequestId
        },
        read: false
      });
      
      await notification.save();
      console.log(`✅ Notification sent to ${acceptedStudent.name} for team acceptance`);

    } else if (status === 'rejected') {
      joinRequest.status = 'rejected';

       // ✅ NEW: Track rejection count
      const rejectionRecord = await TeamRejection.findOneAndUpdate(
        {
          studentId: joinRequest.studentId,
          teamId: teamId
        },
        {
          $inc: { rejectionCount: 1 },
          lastRejectedDate: new Date()
        },
        {
          upsert: true,
          new: true
        }
      );

      console.log(`Rejection count updated for student ${joinRequest.studentId}: ${rejectionRecord.rejectionCount}/3`);

      const notification = new Notification({
        recipientId: joinRequest.studentId,
        type: 'team_rejected',
        title: 'Team Request Declined',
message: rejectionRecord.rejectionCount >= 3 
          ? `Your request to join team "${team.name}" was declined. You have reached the maximum rejection limit (3) for this team.`
          : `Your request to join team "${team.name}" was declined. You can try again later (${rejectionRecord.rejectionCount}/3 rejections).`,
          data: {
          teamId: team._id,
          teamName: team.name,
          rejectedBy: student.name,
          rejectionCount: rejectionRecord.rejectionCount
        },
        read: false
      });
      
      await notification.save();
    } else {
      return res.status(400).json({ message: 'Invalid status' });
    }

    await team.save();
    
    // Return updated team with avatar data
    const updatedTeam = await Team.findById(teamId).lean();
    
    // Add avatar data to members
    const memberStudentIds = updatedTeam.members.map(member => member.studentId);
    const studentsWithAvatars = await Student.find({
      studentId: { $in: memberStudentIds }
    }).select('studentId avatar');
    
    const avatarMap = new Map(
      studentsWithAvatars.map(s => [s.studentId, s.avatar])
    );
    
    updatedTeam.members.forEach(member => {
      member.avatar = avatarMap.get(member.studentId) || null;
      member.avatarUrl = member.avatar;
    });

    res.json({ success: true, message: `Join request ${status}`, team: updatedTeam });

  } catch (error) {
    console.error('Handle join request error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});


// Get rejection status for teams
app.get('/api/teams/rejection-status', authenticate, async (req, res) => {
  try {
    const rejections = await TeamRejection.find({
      studentId: req.user.id
    }).populate('teamId', 'name');

    const rejectionMap = {};
    rejections.forEach(rejection => {
      if (rejection.teamId) {
        rejectionMap[rejection.teamId._id] = {
          rejectionCount: rejection.rejectionCount,
          lastRejectedDate: rejection.lastRejectedDate,
          canRequest: rejection.rejectionCount < 3
        };
      }
    });

    res.json(rejectionMap);
  } catch (error) {
    console.error('Get rejection status error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});


// Get individual team by ID (MISSING ENDPOINT)
app.get('/api/teams/:teamId', authenticate, async (req, res) => {
  try {
    const { teamId } = req.params;
    
    const team = await Team.findById(teamId).lean();
    if (!team) {
      return res.status(404).json({ message: 'Team not found' });
    }

    // Include avatar data for join requests
   if (team.joinRequests && team.joinRequests.length > 0) {
      const studentIds = team.joinRequests.map(req => req.studentId);
      const studentsWithFullData = await Student.find({
        _id: { $in: studentIds }
      }).select('_id studentId completedCredits program avatar name');
      
      const studentDataMap = new Map(
        studentsWithFullData.map(s => [s._id.toString(), {
          avatar: s.avatar,
          studentIdNumber: s.studentId,
          completedCredits: s.completedCredits,
          program: s.program,
          name: s.name
        }])
      );
      
      team.joinRequests.forEach(request => {
        const studentData = studentDataMap.get(request.studentId.toString());
        if (studentData) {
          request.avatar = request.avatar || studentData.avatar;
          request.studentIdNumber = request.studentIdNumber || studentData.studentIdNumber;
          request.completedCredits = request.completedCredits || studentData.completedCredits;
          request.program = request.program || studentData.program;
        }
      });
    }

    res.json(team);
  } catch (error){
    console.error('Get team by ID error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});


// Remove team member (with business rules)
app.post('/api/teams/:teamId/remove-member', authenticate, async (req, res) => {
  try {
    const { teamId } = req.params;
    const { memberStudentId } = req.body;

    const team = await Team.findById(teamId);
    if (!team) {
      return res.status(404).json({ message: 'Team not found' });
    }

    // Check if user is team leader
    const currentUser = await Student.findById(req.user.id);
    const leader = team.members.find(member => member.role === 'Leader');
    
    if (!leader || leader.studentId !== currentUser.studentId) {
      return res.status(403).json({ message: 'Only team leaders can remove members' });
    }

    // Business rule: Cannot remove members if team has only 2 members
    if (team.members.length <= 2) {
      return res.status(400).json({ 
        message: 'Cannot remove members when team has 2 or fewer members. Use dismiss team instead.',
        action: 'dismiss_required'
      });
    }

    // Cannot remove yourself as leader if there are other members
    if (memberStudentId === currentUser.studentId && team.members.length > 1) {
      return res.status(400).json({ 
        message: 'Leaders cannot remove themselves. Transfer leadership first or dismiss the team.'
      });
    }

    // Remove the member
    team.members = team.members.filter(member => member.studentId !== memberStudentId);
    team.memberCount = team.members.length;
    
    // Update team status based on member count
    if (team.members.length < 4) {
      team.status = 'recruiting';
    }

    await team.save();

    // Return updated team with avatar data
    const updatedTeam = await Team.findById(teamId).lean();
    const memberStudentIds = updatedTeam.members.map(member => member.studentId);
    const studentsWithAvatars = await Student.find({
      studentId: { $in: memberStudentIds }
    }).select('studentId avatar');
    
    const avatarMap = new Map(
      studentsWithAvatars.map(s => [s.studentId, s.avatar])
    );
    
    updatedTeam.members.forEach(member => {
      member.avatar = avatarMap.get(member.studentId) || null;
      member.avatarUrl = member.avatar;
    });

    res.json({ 
      success: true, 
      message: 'Member removed successfully',
      team: updatedTeam 
    });

  } catch (error) {
    console.error('Remove member error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Make member a leader
app.post('/api/teams/:teamId/make-leader', authenticate, async (req, res) => {
  try {
    const { teamId } = req.params;
    const { memberStudentId } = req.body;

    const team = await Team.findById(teamId);
    if (!team) {
      return res.status(404).json({ message: 'Team not found' });
    }

    // Check if user is current team leader
    const currentUser = await Student.findById(req.user.id);
    const currentLeader = team.members.find(member => member.role === 'Leader');
    
    if (!currentLeader || currentLeader.studentId !== currentUser.studentId) {
      return res.status(403).json({ message: 'Only current team leader can transfer leadership' });
    }

    // Find the target member
    const targetMember = team.members.find(member => member.studentId === memberStudentId);
    if (!targetMember) {
      return res.status(404).json({ message: 'Target member not found in team' });
    }

    // Update roles: current leader becomes member, target becomes leader
    team.members.forEach(member => {
      if (member.studentId === currentUser.studentId) {
        member.role = 'Member';
      } else if (member.studentId === memberStudentId) {
        member.role = 'Leader';
      }
    });

    await team.save();

    // Return updated team
    const updatedTeam = await Team.findById(teamId).lean();
    const memberStudentIds = updatedTeam.members.map(member => member.studentId);
    const studentsWithAvatars = await Student.find({
      studentId: { $in: memberStudentIds }
    }).select('studentId avatar');
    
    const avatarMap = new Map(
      studentsWithAvatars.map(s => [s.studentId, s.avatar])
    );
    
    updatedTeam.members.forEach(member => {
      member.avatar = avatarMap.get(member.studentId) || null;
      member.avatarUrl = member.avatar;
    });

    res.json({ 
      success: true, 
      message: `${targetMember.name} is now the team leader`,
      team: updatedTeam 
    });

  } catch (error) {
    console.error('Make leader error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Dismiss entire team
app.post('/api/teams/:teamId/dismiss', authenticate, async (req, res) => {
  try {
    const { teamId } = req.params;

    const team = await Team.findById(teamId);
    if (!team) {
      return res.status(404).json({ message: 'Team not found' });
    }

    // Check if user is team leader
    const currentUser = await Student.findById(req.user.id);
    const leader = team.members.find(member => member.role === 'Leader');
    
    if (!leader || leader.studentId !== currentUser.studentId) {
      return res.status(403).json({ message: 'Only team leaders can dismiss the team' });
    }

    // Delete the team completely
    await Team.findByIdAndDelete(teamId);

    res.json({ 
      success: true, 
      message: `Team "${team.name}" has been dismissed successfully`
    });

  } catch (error) {
    console.error('Dismiss team error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Edit team information
app.put('/api/teams/:teamId/edit', authenticate, async (req, res) => {
  try {
    const { teamId } = req.params;
    const { name, major, semester, projectIdea, description } = req.body;

    const team = await Team.findById(teamId);
    if (!team) {
      return res.status(404).json({ message: 'Team not found' });
    }

    // Check if user is team leader
    const currentUser = await Student.findById(req.user.id);
    const leader = team.members.find(member => member.role === 'Leader');
    
    if (!leader || leader.studentId !== currentUser.studentId) {
      return res.status(403).json({ message: 'Only team leaders can edit team information' });
    }

    // Update team information
    if (name && name.trim()) team.name = name.trim();
    if (major) team.major = major;
    if (semester) team.semester = semester;
    if (projectIdea) team.projectIdea = projectIdea;
    if (description) team.description = description;

    await team.save();

    // Return updated team with avatar data
    const updatedTeam = await Team.findById(teamId).lean();
    const memberStudentIds = updatedTeam.members.map(member => member.studentId);
    const studentsWithAvatars = await Student.find({
      studentId: { $in: memberStudentIds }
    }).select('studentId avatar');
    
    const avatarMap = new Map(
      studentsWithAvatars.map(s => [s.studentId, s.avatar])
    );
    
    updatedTeam.members.forEach(member => {
      member.avatar = avatarMap.get(member.studentId) || null;
      member.avatarUrl = member.avatar;
    });

    res.json({ 
      success: true, 
      message: 'Team information updated successfully',
      team: updatedTeam 
    });

  } catch (error) {
    console.error('Edit team error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Cancel sent team request
// Cancel sent team request - Alternative approach
app.post('/api/teams/cancel-request', authenticate, async (req, res) => {
  try {
    const { requestId } = req.body;
    
    const request = await TeamRequest.findById(requestId);
    if (!request) {
      return res.status(404).json({ message: 'Request not found' });
    }

    // Check if the authenticated user is the sender
    if (request.senderId.toString() !== req.user.id) {
      return res.status(403).json({ message: 'You can only cancel your own requests' });
    }

    // Check if request is still pending
    if (request.status !== 'pending') {
      return res.status(400).json({ 
        message: 'Cannot cancel request that has already been processed' 
      });
    }

    // ✅ Use 'rejected' instead of 'cancelled'
    request.status = 'rejected';
    request.responseDate = new Date();
    await request.save();

    res.json({ 
      success: true, 
      message: 'Team request cancelled successfully' 
    });

  } catch (error) {
    console.error('Cancel request error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});



// Get notifications for a student
app.get('/api/notifications/my', authenticate, async (req, res) => {
  try {
    const notifications = await Notification.find({
      recipientId: req.user.id
    }).sort({ createdAt: -1 }).limit(50);

    res.json(notifications);
  } catch (error) {
    console.error('Get notifications error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Mark notification as read
app.put('/api/notifications/:id/read', authenticate, async (req, res) => {
  try {
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, recipientId: req.user.id },
      { read: true },
      { new: true }
    );

    if (!notification) {
      return res.status(404).json({ message: 'Notification not found' });
    }

    res.json(notification);
  } catch (error) {
    console.error('Mark notification read error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get unread notification count
app.get('/api/notifications/unread-count', authenticate, async (req, res) => {
  try {
    const count = await Notification.countDocuments({
      recipientId: req.user.id,
      read: false
    });

    res.json({ count });
  } catch (error) {
    console.error('Get unread count error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});


app.get('/api/teams/requests/incoming', authenticate, async (req, res) => {
  try {
    const cacheKey = `requests_${req.user.id}`;
    const cached = requestCache.get(cacheKey);
    
    // Return cached data if less than 1 second old
    if (cached && (Date.now() - cached.timestamp) < 1000) {
      return res.json(cached.data);
    }
    
    const requests = await TeamRequest.find({
      targetStudentId: req.user.id,
      status: 'pending'
    }).sort({ sentDate: -1 });

    // Cache the result
    requestCache.set(cacheKey, {
      data: requests,
      timestamp: Date.now()
    });
    
    res.json(requests);
  } catch (error) {
    console.error('Get incoming requests error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});


// Send a chat message
// Send a chat message with file support
app.post('/api/teams/:teamId/messages', authenticate, async (req, res) => {
  try {
    const { teamId } = req.params;
    const { message, messageType = 'text', file } = req.body;

    // Verify team exists and user is a member
    const team = await Team.findById(teamId);
    if (!team) {
      return res.status(404).json({ message: 'Team not found' });
    }

    const student = await Student.findById(req.user.id);
    const isMember = team.members.some(member => member.studentId === student.studentId);
    
    if (!isMember) {
      return res.status(403).json({ message: 'You are not a member of this team' });
    }

    // Create new message
    const chatMessage = new ChatMessage({
      teamId,
      senderId: req.user.id,
      senderName: student.name,
      senderStudentId: student.studentId,
      message: message || '',
      messageType: messageType || 'text',
      file: file || null
    });

    await chatMessage.save();

    // Populate sender info for response
    const populatedMessage = await ChatMessage.findById(chatMessage._id)
      .populate('senderId', 'name studentId avatar');

    res.status(201).json({
      success: true,
      message: populatedMessage
    });

  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});


// Get chat messages for a team
app.get('/api/teams/:teamId/messages', authenticate, async (req, res) => {
  try {
    const { teamId } = req.params;
    const { page = 1, limit = 50 } = req.query;

    // Verify team exists and user is a member
    const team = await Team.findById(teamId);
    if (!team) {
      return res.status(404).json({ message: 'Team not found' });
    }

    const student = await Student.findById(req.user.id);
    const isMember = team.members.some(member => member.studentId === student.studentId);
    
    if (!isMember) {
      return res.status(403).json({ message: 'You are not a member of this team' });
    }

    // Get messages with pagination
    const messages = await ChatMessage.find({ teamId })
      .populate('senderId', 'name studentId avatar')
      .sort({ timestamp: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    // Reverse to show oldest first
    const sortedMessages = messages.reverse();

    res.json({
      success: true,
      messages: sortedMessages,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: await ChatMessage.countDocuments({ teamId })
      }
    });

  } catch (error) {
    console.error('Get messages error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Delete a message (only sender can delete)
app.delete('/api/teams/:teamId/messages/:messageId', authenticate, async (req, res) => {
  try {
    const { teamId, messageId } = req.params;

    const message = await ChatMessage.findOne({
      _id: messageId,
      teamId,
      senderId: req.user.id
    });

    if (!message) {
      return res.status(404).json({ message: 'Message not found or unauthorized' });
    }

    await ChatMessage.findByIdAndDelete(messageId);

    res.json({ success: true, message: 'Message deleted' });

  } catch (error) {
    console.error('Delete message error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Edit a message (only sender can edit)
app.put('/api/teams/:teamId/messages/:messageId', authenticate, async (req, res) => {
  try {
    const { teamId, messageId } = req.params;
    const { message: newMessage } = req.body;

    const message = await ChatMessage.findOne({
      _id: messageId,
      teamId,
      senderId: req.user.id
    });

    if (!message) {
      return res.status(404).json({ message: 'Message not found or unauthorized' });
    }

    message.message = newMessage;
    message.isEdited = true;
    message.editedAt = new Date();
    await message.save();

    const populatedMessage = await ChatMessage.findById(messageId)
      .populate('senderId', 'name studentId avatar');

    res.json({ success: true, message: populatedMessage });

  } catch (error) {
    console.error('Edit message error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});


// Add to server.js - Call logging endpoint
app.post('/api/teams/:teamId/call-log', authenticate, async (req, res) => {
  try {
    const { teamId } = req.params;
    const { action, participants } = req.body; // action: 'started' | 'ended'

    const team = await Team.findById(teamId);
    if (!team) {
      return res.status(404).json({ message: 'Team not found' });
    }

    const student = await Student.findById(req.user.id);
    const isMember = team.members.some(member => member.studentId === student.studentId);
    
    if (!isMember) {
      return res.status(403).json({ message: 'You are not a member of this team' });
    }

    // Log the call activity
    console.log(`Team ${team.name} call ${action} by ${student.name}`);
    
    res.json({ success: true, message: `Call ${action} logged` });

  } catch (error) {
    console.error('Call log error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Add JWT generation endpoint
app.post('/api/generate-jwt', authenticate, async (req, res) => {
  try {
    const { userId, userName, email } = req.body;
    
    // Generate JWT token (you'll need to implement this based on your requirements)
    const jwtToken = generateJitsiJWT({
      userId,
      userName,
      email,
      // Add other required claims
    });
    
    res.json({ jwtToken });
  } catch (error) {
    console.error('JWT generation error:', error);
    res.status(500).json({ message: 'Failed to generate JWT token' });
  }
});


// Add this endpoint to your server.js file
app.post('/api/agora/token', authenticate, async (req, res) => {
  try {
    const { channelName, uid } = req.body;
    
    // Agora credentials (store these securely in environment variables)
    const APP_ID = process.env.AGORA_APP_ID || '50e028a1a8224f78ab8d78beb6041a8b';
    const APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE;
    
    if (!APP_CERTIFICATE) {
      console.warn('Agora certificate not configured, using app ID only');
      return res.json({
        token: null,
        appId: APP_ID,
        channelName,
        uid,
        expiresAt: null
      });
    }
    
    // Token expires in 24 hours
    const expirationTimeInSeconds = 3600 * 24;
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;
    
    // Generate token using Agora's token builder
    const { RtcTokenBuilder, RtcRole } = require('agora-access-token');
    const token = RtcTokenBuilder.buildTokenWithUid(
      APP_ID,
      APP_CERTIFICATE,
      channelName,
      uid,
      RtcRole.PUBLISHER,
      privilegeExpiredTs
    );
    
    res.json({
      token,
      appId: APP_ID,
      channelName,
      uid,
      expiresAt: privilegeExpiredTs
    });
    
  } catch (error) {
    console.error('Token generation error:', error);
    res.status(500).json({ error: 'Failed to generate token' });
  }
});

const corsOptions = {
  origin: [
    'http://localhost:3000', // Development
    'https://supervise-me.netlify.app', // Production
  ],
  credentials: true,
  optionsSuccessStatus: 200
};

// Upload file to Cloudinary
// File upload route - FIXED VERSION
app.post('/api/files/upload', authenticate, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    const fileStr = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    
    const timestamp = Date.now();
    const originalName = req.file.originalname.split('.')[0];
    const extension = req.file.originalname.split('.').pop();
    const uniqueFilename = `${originalName}_${timestamp}`;

    // ✅ CRITICAL FIX: Use 'auto' resource_type for all files
    const uploadResponse = await cloudinary.uploader.upload(fileStr, {
      upload_preset: process.env.CLOUDINARY_UPLOAD_PRESET,
      folder: `${process.env.CLOUDINARY_FOLDER}/${req.body.teamId || 'general'}`,
      public_id: uniqueFilename,
      resource_type: 'auto',        // ✅ This fixes the download issue
      overwrite: false,
      unique_filename: true,
      use_filename: true,
    });

    res.status(200).json({
      success: true,
      file: {
        public_id: uploadResponse.public_id,
        url: uploadResponse.secure_url,  // ✅ Use secure_url directly
        originalName: req.file.originalname,
        size: req.file.size,
        mimetype: req.file.mimetype,
        format: uploadResponse.format,
        resource_type: uploadResponse.resource_type,
        created_at: uploadResponse.created_at,
      }
    });

  } catch (error) {
    console.error('File upload error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'File upload failed',
      error: error.message 
    });
  }
});


// Delete file from Cloudinary
app.delete('/api/files/delete/:publicId', authenticate, async (req, res) => {
  try {
    const { publicId } = req.params;
    
    const result = await cloudinary.uploader.destroy(publicId);
    
    if (result.result === 'ok') {
      res.status(200).json({ 
        success: true, 
        message: 'File deleted successfully' 
      });
    } else {
      res.status(400).json({ 
        success: false, 
        message: 'File deletion failed' 
      });
    }
  } catch (error) {
    console.error('File deletion error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'File deletion failed',
      error: error.message 
    });
  }
});

// Optional: Dedicated download route with proper headers
// Replace the existing /api/files/download endpoint with this:
// Updated download endpoint with signed URLs
app.get('/api/files/download/:publicId', authenticate, async (req, res) => {
  try {
    const { publicId } = req.params;
    
    // Generate signed URL valid for 1 minute
    const signedUrl = cloudinary.url(publicId, {
      resource_type: 'auto',
      sign_url: true,
      expires_at: Math.floor(Date.now() / 1000) + 60, // 1 minute expiration
      type: 'authenticated'
    });

    res.redirect(signedUrl);
  } catch (error) {
    console.error('Download error:', error);
    res.status(404).json({ message: 'File not found' });
  }
});



// API Routes for Auto-Group Settings
app.get('/api/admin/auto-group-settings', authenticate, async (req, res) => {
  try {
    let settings = await AutoGroupSettings.findOne({});
    if (!settings) {
      settings = new AutoGroupSettings();
      await settings.save();
    }
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/auto-group-settings', authenticate, async (req, res) => {
  try {
    const settingsData = req.body;
    let settings = await AutoGroupSettings.findOne({});
    
    if (settings) {
      Object.assign(settings, settingsData);
    } else {
      settings = new AutoGroupSettings(settingsData);
    }
    
    await settings.save();
    
    // Restart the auto-group checker with new interval
    restartAutoGroupChecker();
    
    res.json({ success: true, message: 'Auto-group settings saved successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== AUTOMATIC GROUP CREATION SYSTEM =====
// Add this section after your API routes but before server startup

// Helper function to get current semester
const getCurrentSemester = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1; // 0-based to 1-based
  
  if (month >= 1 && month <= 6) {
    return `Spring ${year}`;
  } else if (month >= 7 && month <= 12) {
    return `Fall ${year}`;
  }
  return `Academic ${year}`;
};

// Auto-group checker interval management
let autoGroupInterval;

const startAutoGroupChecker = async () => {
  const settings = await AutoGroupSettings.findOne({});
  if (!settings || !settings.enabled) return;

  const intervalMs = settings.checkIntervalMinutes * 60 * 1000;
  
  autoGroupInterval = setInterval(() => {
    createAutomaticGroups();
  }, intervalMs);
  
  console.log(`🕐 Auto-group checker started with ${settings.checkIntervalMinutes} minute interval`);
  
  // Run initial check after 5 seconds
  setTimeout(createAutomaticGroups, 5000);
};

const restartAutoGroupChecker = () => {
  if (autoGroupInterval) {
    clearInterval(autoGroupInterval);
  }
  startAutoGroupChecker();
};

// Automatic Group Creation Logic
const createAutomaticGroups = async () => {
  try {
    console.log('🤖 Running automatic group creation check...');
    
    const settings = await AutoGroupSettings.findOne({});
    if (!settings || !settings.enabled) {
      console.log('⏸️ Auto-grouping is disabled');
      return;
    }

    // Find eligible students without teams
    const eligibleStudents = await Student.find({
      status: 'Active',
      completedCredits: { $gte: settings.minCreditsRequired },
      teamId: { $exists: false }
    });

    // Filter out students who already have teams in the Team collection
    const studentsWithTeams = await Team.find({
      'members.studentId': { $in: eligibleStudents.map(s => s.studentId) }
    });

    const studentsInTeams = new Set();
    studentsWithTeams.forEach(team => {
      team.members.forEach(member => {
        studentsInTeams.add(member.studentId);
      });
    });

    const availableStudents = eligibleStudents.filter(student => 
      !studentsInTeams.has(student.studentId)
    );

    const studentCount = availableStudents.length;
    console.log(`📊 Found ${studentCount} eligible students for auto-grouping`);

    if (studentCount === 0) {
      console.log('✅ No students need auto-grouping');
      return;
    }

    // Check if automatic creation should happen
    if (studentCount >= 5) {
      console.log('👥 5+ students available - manual group creation mode');
      return;
    }

    if (studentCount === 1 && !settings.allowSoloGroups) {
      console.log('👤 1 student available but solo groups disabled');
      return;
    }

    // Create automatic groups
    let groupsCreated = 0;

    if (studentCount >= 2 && studentCount <= 4) {
      // Create one group with all remaining students
      const teamName = `Auto-Group-${Date.now()}`;
      const leader = availableStudents[0];

      const newTeam = new Team({
        name: teamName,
        major: leader.program || 'Computer Science',
        capstone: 'CSE 400',
        semester: getCurrentSemester(),
        projectIdea: 'Auto-generated group for CSE 400',
        description: 'Automatically created group',
        members: availableStudents.map((student, index) => ({
          studentId: student.studentId,
          name: student.name,
          email: student.email,
          program: student.program || 'Computer Science',
          role: index === 0 ? 'Leader' : 'Member',
          joinedDate: new Date()
        })),
        status: 'recruiting',
        memberCount: availableStudents.length,
        maxMembers: 4,
        autoCreated: true,
        createdDate: new Date()
      });

      await newTeam.save();
      
      // Update students with team reference
      const studentIds = availableStudents.map(s => s._id);
      await Student.updateMany(
        { _id: { $in: studentIds } },
        { teamId: newTeam._id }
      );

      groupsCreated++;
      console.log(`✅ Created automatic group: ${teamName} with ${availableStudents.length} members`);

      // Send notifications to all group members
      for (const student of availableStudents) {
        const notification = new Notification({
          recipientId: student._id,        // ✅ Changed from studentId to recipientId
          type: 'general',                   // ✅ Changed from 'info' to 'team' 
          title: 'Automatic Group Created',
          message: `You have been automatically assigned to team "${teamName}" for CSE 400.`,
          date: new Date(),
          read: false
        });
        await notification.save();
      }

    } 
    else if (studentCount === 1 && settings.allowSoloGroups) {
      // Create solo group
      const student = availableStudents[0];
      const teamName = `Solo-${student.name.replace(/\s+/g, '')}-${Date.now()}`;

      const soloTeam = new Team({
        name: teamName,
        major: student.program || 'Computer Science',
        capstone: 'CSE 400',
        semester: getCurrentSemester(),
        projectIdea: 'Solo project for CSE 400',
        description: 'Automatically created solo group',
        members: [{
          studentId: student.studentId,
          name: student.name,
          email: student.email,
          program: student.program || 'Computer Science',
          role: 'Leader',
          joinedDate: new Date()
        }],
        status: 'active',
        memberCount: 1,
        maxMembers: 1,
        autoCreated: true,
        soloGroup: true,
        createdDate: new Date()
      });

      await soloTeam.save();
      await Student.findByIdAndUpdate(student._id, { teamId: soloTeam._id });

      groupsCreated++;
      console.log(`✅ Created solo group: ${teamName} for ${student.name}`);

      // Send notification to the solo student
      const notification = new Notification({
        recipientId: student._id,          // ✅ Changed from studentId to recipientId
        type: 'general',                     // ✅ Changed from 'info' to 'team'
        title: 'Solo Group Created',
        message: `You have been automatically assigned to a solo team "${teamName}" for CSE 400.`,
        date: new Date(),
        read: false
      });
      await notification.save();
    }

    // Update settings with last check time and total groups created
    if (groupsCreated > 0) {
      await AutoGroupSettings.findOneAndUpdate(
        {},
        { 
          lastCheck: new Date(),
          $inc: { totalAutoGroups: groupsCreated }
        }
      );
      
      console.log(`🎉 Auto-group creation completed. Created ${groupsCreated} groups.`);
    } else {
      await AutoGroupSettings.findOneAndUpdate({}, { lastCheck: new Date() });
    }

  } catch (error) {
    console.error('❌ Auto-group creation error:', error);
  }
};


// ✅ ADD THIS NEW ENDPOINT
app.get('/api/notifications/my-notifications', authenticate, async (req, res) => {
  try {
    const studentId = req.user.id;
    
    const notifications = await Notification.find({
      recipientId: studentId
    })
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();
    
    res.json({
      success: true,
      notifications
    });
    
  } catch (error) {
    console.error('Fetch notifications error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ✅ ADD THIS: Mark notification as read
app.put('/api/notifications/:notificationId/read', authenticate, async (req, res) => {
  try {
    const { notificationId } = req.params;
    const studentId = req.user.id;
    
    await Notification.findOneAndUpdate(
      { 
        _id: notificationId, 
        recipientId: studentId 
      },
      { read: true }
    );
    
    res.json({ success: true });
    
  } catch (error) {
    console.error('Mark notification read error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});


// ===== END OF AUTOMATIC GROUP CREATION SYSTEM =====

// ✅ OPTIONAL: Add Socket.IO for real-time notifications
const http = require('http');
const socketIo = require('socket.io');

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: process.env.REACT_APP_CLIENT_URL || "http://localhost:3000",
    methods: ["GET", "POST"]
  }
});

// Store user socket connections
const userSockets = new Map();

io.on('connection', (socket) => {
  socket.on('join', (userId) => {
    userSockets.set(userId, socket.id);
    console.log(`User ${userId} connected with socket ${socket.id}`);
  });

  socket.on('disconnect', () => {
    for (let [userId, socketId] of userSockets.entries()) {
      if (socketId === socket.id) {
        userSockets.delete(userId);
        console.log(`User ${userId} disconnected`);
        break;
      }
    }
  });
});

// Helper function to emit notification
const emitNotification = (userId, notification) => {
  const socketId = userSockets.get(userId.toString());
  if (socketId) {
    io.to(socketId).emit('notification', notification);
  }
};

// Add this endpoint after your existing authentication routes
app.post('/api/refresh-session', authenticate, async (req, res) => {
  try {
    const user = req.user;
    
    // Generate a new token with extended expiration
    const newToken = jwt.sign(
      { id: user.id, role: user.role }, 
      JWT_SECRET, 
      { expiresIn: '1h' } // Extend for another hour
    );
    
    // Optionally update last activity in database
    if (user.role === 'student') {
      await Student.findByIdAndUpdate(user.id, {
        lastActivity: new Date()
      });
    } else if (user.role === 'faculty') {
      await Faculty.findByIdAndUpdate(user.id, {
        lastActivity: new Date()
      });
    }
    
    res.json({ 
      success: true, 
      token: newToken,
      message: 'Session extended successfully',
      expiresIn: 3600 // 1 hour in seconds
    });
    
  } catch (error) {
    console.error('Session refresh error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to extend session' 
    });
  }
});





app.use(cors(corsOptions));
// Initialize configuration and start server
server.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  console.log('Registered routes:');
  console.log('POST /api/teams/send-request');
  console.log('GET /api/teams/requests/incoming');
  console.log('POST /api/teams/accept-request');
  console.log('POST /api/teams/reject-request');
  console.log('GET /api/teams/all');
  console.log('GET /api/students/available');
  console.log('GET /api/admin/auto-group-settings'); // ✅ Add this
  console.log('POST /api/admin/auto-group-settings'); // ✅ Add this
  
  await createAdmin();
  await initializeConfig();
  startAutoGroupChecker(); // ✅ Add this line
});
