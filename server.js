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
  'application/pdf', 
  'application/msword', 
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint', 
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/zip',
  'application/x-zip-compressed',
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
      recipientType,
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
// Updated Notification Schema to support both students and faculty
const notificationSchema = new mongoose.Schema({
  recipientId: { 
    type: mongoose.Schema.Types.ObjectId, 
    required: true,
    refPath: 'recipientType'
  },
  recipientType: {
    type: String,
    required: true,
    enum: ['Student', 'Faculty']
  },
  type: { 
    type: String, 
    enum: [
      'team_request', 
      'team_accepted', 
      'team_rejected', 
      'general',
      'support_response', 
      'support_resolved', 
      'support_closed',   
      'support_update',
      'supervision_request',
      'deliverable_submitted',
      'deliverable_assigned',
      'team_message',
      'member_joined',
      'member_left'
    ], 
    default: 'general' 
  },
  title: { type: String, required: true },
  message: { type: String, required: true },
  data: {
    senderName: String,
    senderStudentId: String,
    teamName: String,
    teamId: String,
    requestId: String,
    ticketId: String,
    ticketSubject: String,
    ticketStatus: String,
    adminResponse: String,
    category: String,
    priority: String,
    deliverableId: String,
    deliverableName: String,
    submissionId: String,
    facultyId: String,
    facultyName: String
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
// Modified ChatMessage Schema to support both students and faculty
const chatMessageSchema = new mongoose.Schema({
  teamId: { type: mongoose.Schema.Types.ObjectId, ref: 'Team', required: true },
  senderId: { type: mongoose.Schema.Types.ObjectId, required: true }, // Can be Student or Faculty
  senderName: { type: String, required: true },
  senderIdentifier: { type: String, required: true }, // studentId or facultyEmail
  senderType: { 
    type: String, 
    enum: ['student', 'faculty'], 
    required: true 
  }, // NEW: Identify sender type
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
  isEdited: { type: Boolean, default: false },
  readBy: [{
    facultyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Faculty' },
    readAt: { type: Date, default: Date.now }
  }]
}, { timestamps: true });


const ChatMessage = mongoose.model('ChatMessage', chatMessageSchema);




// Add these schemas after your existing schemas in server.js

// Deliverable Definition Schema
const deliverableSchema = new mongoose.Schema({
  teamId: { type: mongoose.Schema.Types.ObjectId, ref: 'Team', required: true },
  supervisorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Faculty', required: true },
  name: { type: String, required: true },
  description: { type: String },
  phase: { type: String, enum: ['A', 'B', 'C'], required: true },
  deadline: { type: Date, required: true },
  allowedFileTypes: [{ type: String }], // ['pdf', 'docx', 'zip', 'pptx']
  maxFileSize: { type: Number, default: 20 }, // in MB
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Deliverable Submission Schema
const deliverableSubmissionSchema = new mongoose.Schema({
  deliverableId: { type: mongoose.Schema.Types.ObjectId, ref: 'Deliverable', required: true },
  teamId: { type: mongoose.Schema.Types.ObjectId, ref: 'Team', required: true },
  submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
  submitterName: { type: String, required: true },
  fileName: { type: String, required: true },
  originalName: { type: String, required: true },
  fileSize: { type: Number, required: true },
  fileType: { type: String, required: true },
  cloudinaryId: { type: String, required: true },
  fileUrl: { type: String, required: true },
  
  // Review fields
  status: { 
    type: String, 
    enum: ['pending', 'approved', 'rejected', 'needs_revision'], 
    default: 'pending' 
  },
  feedback: { type: String, default: '' },
  marks: { type: Number, min: 0, max: 100 },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Faculty' },
  reviewedAt: { type: Date },
  
  submittedAt: { type: Date, default: Date.now },
  version: { type: Number, default: 1 }, // For resubmissions
  isLatest: { type: Boolean, default: true }
});

const Deliverable = mongoose.model('Deliverable', deliverableSchema);
const DeliverableSubmission = mongoose.model('DeliverableSubmission', deliverableSubmissionSchema);


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

const materialSchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: String,
  fileName: { type: String, required: true },
  fileType: { type: String, required: true },
  fileSize: { type: Number, required: true },
  fileUrl: { type: String, required: true },
  downloadUrl: { type: String, required: true },
  cloudinaryId: { type: String, required: true },
  
  // Faculty who uploaded
  uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Faculty', required: true },
  uploadedByName: { type: String, required: true },
  
  // Target audience
  targetType: { 
    type: String, 
    enum: ['all', 'phase', 'teams', 'students'], 
    required: true 
  },
  targetPhase: String,
  targetTeams: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Team' }],
  targetStudents: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Student' }],
  
  // Metadata
  uploadDate: { type: Date, default: Date.now },
  isActive: { type: Boolean, default: true },
  downloadCount: { type: Number, default: 0 }
}, { timestamps: true });

const Material = mongoose.model('Material', materialSchema);
console.log('✅ Material model registered:', Material.modelName);




// Custom milestone schema
const customMilestoneSchema = new mongoose.Schema({
  teamId: { type: mongoose.Schema.Types.ObjectId, ref: 'Team', required: true },
  supervisorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Faculty', required: true },
  name: { type: String, required: true, maxlength: 100 },
  description: { type: String, maxlength: 500 },
  phase: { type: String, enum: ['A', 'B', 'C'], required: true },
  weight: { type: Number, min: 1, max: 100, required: true },
  dueDate: { type: Date },
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

const CustomMilestone = mongoose.model('CustomMilestone', customMilestoneSchema);

// Schema for supervisor-customized predefined milestones
const customPredefinedMilestoneSchema = new mongoose.Schema({
  supervisorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Faculty', required: true },
  phase: { type: String, enum: ['A', 'B', 'C'], required: true },
  milestoneId: { type: String, required: true }, // original predefined milestone ID
  name: { type: String, required: true },
  weight: { type: Number, min: 1, max: 100, required: true },
  description: { type: String },
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

const CustomPredefinedMilestone = mongoose.model('CustomPredefinedMilestone', customPredefinedMilestoneSchema);


// Board Schema - Add this after your other schemas
const boardSchema = new mongoose.Schema({
  name: { 
    type: String, 
    required: true, 
    unique: true 
  },
  description: { 
    type: String, 
    default: '' 
  },
  faculty: [{
    _id: { type: mongoose.Schema.Types.ObjectId, ref: 'Faculty' },
    name: { type: String, required: true },
    email: { type: String, required: true },
    department: { type: String, required: true },
    assignedDate: { type: Date, default: Date.now }
  }],
  totalTeams: { 
    type: Number, 
    default: 0 
  },
  isActive: { 
    type: Boolean, 
    default: true 
  },
  createdAt: { 
    type: Date, 
    default: Date.now 
  },
  updatedAt: { 
    type: Date, 
    default: Date.now 
  }
}, { timestamps: true });

const Board = mongoose.model('Board', boardSchema);

// Update the existing boardEvaluationSchema in server.js
// Update the existing boardEvaluationSchema in server.js
const boardEvaluationSchema = new mongoose.Schema({
  boardId: { type: mongoose.Schema.Types.ObjectId, ref: 'Board', required: true },
  teamId: { type: mongoose.Schema.Types.ObjectId, ref: 'Team', required: true },
  phase: { type: String, enum: ['A', 'B', 'C'], required: true },
  
  // Individual faculty evaluations
  evaluations: [{
    facultyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Faculty', required: true },
    facultyName: { type: String, required: true },
    isSupervisor: { type: Boolean, default: false },
    evaluationType: { 
      type: String, 
      enum: ['team', 'individual'], 
      required: true 
    },
    teamMark: { 
      type: Number, 
      min: 0, 
      max: 100,
      required: function() { return this.evaluationType === 'team'; }
    },
    teamFeedback: { type: String },
    individualMarks: [{
      studentId: { type: String, required: true },
      studentName: { type: String, required: true },
      mark: { type: Number, min: 0, max: 100, required: true },
      feedback: { type: String }
    }],
    submittedAt: { type: Date, default: Date.now },
    isSubmitted: { type: Boolean, default: false },
    lastModified: { type: Date, default: Date.now }
  }],
  
  // Faculty calculated results (before admin review)
  facultyResults: {
    teamAverage: { type: Number },
    teamGrade: { type: String },
    teamGPA: { type: Number },
    individualResults: [{
      studentId: { type: String },
      studentName: { type: String },
      finalMark: { type: Number },
      grade: { type: String },
      gpa: { type: Number },
      breakdown: {
        boardAverage: { type: Number },
        supervisorMark: { type: Number },
        finalCalculation: { type: String }
      }
    }]
  },
  
  // NEW: Admin review fields
  adminReview: {
    isReviewed: { type: Boolean, default: false },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
    reviewedAt: { type: Date },
    adminComments: { type: String },
    
    // Admin can modify individual grades
    modifiedGrades: [{
      studentId: { type: String, required: true },
      studentName: { type: String, required: true },
      originalMark: { type: Number, required: true },
      modifiedMark: { type: Number, required: true },
      modificationReason: { type: String },
      modifiedAt: { type: Date, default: Date.now }
    }],
    
    isFinalized: { type: Boolean, default: false },
    finalizedAt: { type: Date }
  },
  
  // Final results (after admin review/modification)
  finalResults: {
    teamAverage: { type: Number },
    teamGrade: { type: String },
    teamGPA: { type: Number },
    individualResults: [{
      studentId: { type: String },
      studentName: { type: String },
      finalMark: { type: Number },
      grade: { type: String },
      gpa: { type: Number },
      isModified: { type: Boolean, default: false },
      modificationReason: { type: String },
      breakdown: {
        boardAverage: { type: Number },
        supervisorMark: { type: Number },
        adminAdjustment: { type: Number },
        finalCalculation: { type: String }
      }
    }]
  },
  
  totalEvaluators: { type: Number, default: 0 },
  submittedEvaluations: { type: Number, default: 0 },
  isCompleted: { type: Boolean, default: false },
  completedAt: { type: Date },
  
  // NEW: Status tracking
  status: {
    type: String,
    enum: ['in_progress', 'pending_admin_review', 'admin_reviewed', 'finalized'],
    default: 'in_progress'
  }
}, { timestamps: true });

const BoardEvaluation = mongoose.model('BoardEvaluation', boardEvaluationSchema);


// Add these functions to server.js

// Updated GRADING_SCALE with your specifications
const BOARD_GRADING_SCALE = [
  { min: 80, max: 100, letter: 'A+', gpa: 4.00 },
  { min: 75, max: 79.99, letter: 'A', gpa: 3.75 },
  { min: 70, max: 74.99, letter: 'A-', gpa: 3.50 },
  { min: 65, max: 69.99, letter: 'B+', gpa: 3.25 },
  { min: 60, max: 64.99, letter: 'B', gpa: 3.00 },
  { min: 55, max: 59.99, letter: 'B-', gpa: 2.75 },
  { min: 50, max: 54.99, letter: 'C+', gpa: 2.50 },
  { min: 45, max: 49.99, letter: 'C', gpa: 2.25 },
  { min: 40, max: 44.99, letter: 'D', gpa: 2.00 },
  { min: 0, max: 39.99, letter: 'F', gpa: 0.00 }
];

// Convert percentage to grade using board grading scale
const convertToGrade = (percentage) => {
  if (percentage < 0 || percentage > 100) {
    return { letter: 'Invalid', gpa: 0.00, valid: false };
  }
  
  const grade = BOARD_GRADING_SCALE.find(scale => 
    percentage >= scale.min && percentage <= scale.max
  );
  
  return {
    percentage: parseFloat(percentage).toFixed(2),
    letter: grade.letter,
    gpa: grade.gpa,
    valid: true
  };
};

// Calculate final evaluation results
const calculateFinalEvaluationResults = (boardEvaluation, teamMembers) => {
  const evaluations = boardEvaluation.evaluations.filter(eval => eval.isSubmitted);
  
  if (evaluations.length === 0) {
    return null;
  }
  
  const supervisorEval = evaluations.find(eval => eval.isSupervisor);
  const boardEvals = evaluations.filter(eval => !eval.isSupervisor);
  
  // Separate team-level and individual evaluations
  const teamLevelEvals = evaluations.filter(eval => eval.evaluationType === 'team');
  const individualEvals = evaluations.filter(eval => eval.evaluationType === 'individual');
  
  let finalResults = {
    individualResults: []
  };
  
  // Process each team member
  teamMembers.forEach(member => {
    let finalMark = 0;
    let breakdown = {
      boardAverage: 0,
      supervisorMark: 0,
      finalCalculation: ''
    };
    
    // Collect all marks for this student
    let studentMarks = [];
    let boardMarks = [];
    let supervisorMark = null;
    
    evaluations.forEach(evaluation => {
      if (evaluation.evaluationType === 'team') {
        // Team-level mark applies to all members
        const mark = evaluation.teamMark;
        studentMarks.push(mark);
        
        if (evaluation.isSupervisor) {
          supervisorMark = mark;
        } else {
          boardMarks.push(mark);
        }
      } else if (evaluation.evaluationType === 'individual') {
        // Individual mark for this specific student
        const individualMark = evaluation.individualMarks.find(
          mark => mark.studentId === member.studentId
        );
        
        if (individualMark) {
          const mark = individualMark.mark;
          studentMarks.push(mark);
          
          if (evaluation.isSupervisor) {
            supervisorMark = mark;
          } else {
            boardMarks.push(mark);
          }
        }
      }
    });
    
    // Calculate averages
    const boardAverage = boardMarks.length > 0 ? 
      boardMarks.reduce((sum, mark) => sum + mark, 0) / boardMarks.length : 0;
    
    // Final calculation logic
    if (supervisorMark !== null && boardMarks.length > 0) {
      // Mix of board and supervisor marks
      finalMark = (boardAverage + supervisorMark) / 2;
      breakdown.finalCalculation = `Average of Board (${boardAverage.toFixed(1)}) and Supervisor (${supervisorMark})`;
    } else if (studentMarks.length > 0) {
      // Average all marks
      finalMark = studentMarks.reduce((sum, mark) => sum + mark, 0) / studentMarks.length;
      breakdown.finalCalculation = `Average of all ${studentMarks.length} evaluations`;
    }
    
    breakdown.boardAverage = boardAverage;
    breakdown.supervisorMark = supervisorMark || 0;
    
    const gradeInfo = convertToGrade(finalMark);
    
    finalResults.individualResults.push({
      studentId: member.studentId,
      studentName: member.name,
      finalMark: parseFloat(finalMark.toFixed(2)),
      grade: gradeInfo.letter,
      gpa: gradeInfo.gpa,
      breakdown: breakdown
    });
  });
  
  // Calculate team average
  if (finalResults.individualResults.length > 0) {
    const teamAverage = finalResults.individualResults.reduce(
      (sum, result) => sum + result.finalMark, 0
    ) / finalResults.individualResults.length;
    
    const teamGrade = convertToGrade(teamAverage);
    finalResults.teamAverage = parseFloat(teamAverage.toFixed(2));
    finalResults.teamGrade = teamGrade.letter;
    finalResults.teamGPA = teamGrade.gpa;
  }
  
  return finalResults;
};


// Add phase detection function
const determinePhaseFromSemester = (semester) => {
  if (!semester) return 'A';
  
  const currentDate = new Date();
  const currentYear = currentDate.getFullYear();
  const currentMonth = currentDate.getMonth() + 1; // 0-based to 1-based
  
  // Parse semester (e.g., "Spring 2024", "Fall 2024")
  const [semesterType, yearStr] = semester.split(' ');
  const semesterYear = parseInt(yearStr);
  
  if (!semesterYear) return 'A';
  
  // Calculate phase based on time elapsed since semester start
  const yearsDiff = currentYear - semesterYear;
  const isCurrentYear = yearsDiff === 0;
  const isPastYear = yearsDiff > 0;
  
  if (isPastYear) {
    return 'C'; // Past semesters are in final phase
  }
  
  if (isCurrentYear) {
    // Determine phase based on current month and semester type
    if (semesterType === 'Spring') {
      if (currentMonth >= 1 && currentMonth <= 4) return 'A';
      if (currentMonth >= 5 && currentMonth <= 8) return 'B';
      return 'C';
    } else if (semesterType === 'Summer') {
      if (currentMonth >= 5 && currentMonth <= 6) return 'A';
      if (currentMonth >= 7 && currentMonth <= 8) return 'B';
      return 'C';
    } else if (semesterType === 'Fall') {
      if (currentMonth >= 9 && currentMonth <= 11) return 'A';
      if (currentMonth >= 12 || currentMonth <= 2) return 'B';
      return 'C';
    }
  }
  
  return 'A'; // Default for future semesters
};

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
  skills: [{  // Add this skills field
    type: String,
    trim: true
  }],
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

  const transporter = nodemailer.createTransport({
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

  const transporter = nodemailer.createTransport({
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
// Authentication middleware
const authenticate = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Access denied' });

  try {
    const verified = jwt.verify(token, JWT_SECRET);
    req.user = verified;

    if (req.user.role === 'admin') {
      // Admin users have full access, no additional checks needed
      return next();
    }

    if (req.user.role === 'student') {
      const config = await Config.findOne();
      const student = await Student.findById(req.user.id);
      
      if (!student) return res.status(404).json({ message: 'Student not found' });
      
      // ✅ CHECK: Allow access if student meets credits OR is in a team (special access)
      const isEligible = student.completedCredits >= config.requiredCredits;
      const studentTeam = await Team.findOne({
        'members.studentId': student.studentId
      });
      const isInTeam = studentTeam !== null;
      
      // Block only if student is ineligible AND not in any team
      if (!isEligible && !isInTeam) {
        return res.status(403).json({ 
          message: `Credit requirement increased. You need ${config.requiredCredits} credits.` 
        });
      }
      
      // ✅ ADD: Store special access info in request for use in other endpoints
      req.user.hasSpecialAccess = !isEligible && isInTeam;
      req.user.isEligible = isEligible;
      req.user.isInTeam = isInTeam;
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
 const token = jwt.sign({ 
      id: admin._id, 
      role: 'admin' 
    }, JWT_SECRET, { expiresIn: '1h' });
    
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

     const studentTeam = await Team.findOne({
      'members.studentId': student.studentId
    });

    // Allow login if student meets credit requirement OR is in a team
    const isEligible = student.completedCredits >= requiredCredits;
    const isInTeam = studentTeam !== null;
    
if (!isEligible && !isInTeam) {
      return res.status(403).json({ 
        message: `You need at least ${requiredCredits} completed credits to login.` 
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
        email: student.email,
        isEligible: isEligible,
        isInTeam: isInTeam,
        teamName: studentTeam?.name || null,
        hasSpecialAccess: !isEligible && isInTeam // ✅ ADD: Special access flag
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

// Update student skills
app.put('/api/students/skills', authenticate, async (req, res) => {
  try {
    const { skills } = req.body;
    
    // Validate skills array
    if (!Array.isArray(skills)) {
      return res.status(400).json({ message: 'Skills must be an array' });
    }
    
    // Clean and validate skills
    const cleanSkills = skills
      .map(skill => skill.trim())
      .filter(skill => skill.length > 0 && skill.length <= 50)
      .slice(0, 10); // Limit to 10 skills
    
    const updatedStudent = await Student.findByIdAndUpdate(
      req.user.id,
      { skills: cleanSkills },
      { new: true }
    ).select('-password');
    
    if (!updatedStudent) {
      return res.status(404).json({ message: 'Student not found' });
    }
    
    res.json({
      success: true,
      message: 'Skills updated successfully',
      skills: updatedStudent.skills
    });
    
  } catch (error) {
    console.error('Update skills error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get student skills
app.get('/api/students/skills', authenticate, async (req, res) => {
  try {
    const student = await Student.findById(req.user.id).select('skills');
    
    if (!student) {
      return res.status(404).json({ message: 'Student not found' });
    }
    
    res.json({
      success: true,
      skills: student.skills || []
    });
    
  } catch (error) {
    console.error('Get skills error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get materials for students
app.get('/api/students/materials', authenticate, async (req, res) => {
  try {
    console.log('📚 Loading materials for user:', req.user.id, 'role:', req.user.role);

    if (req.user.role !== 'student') {
      return res.status(403).json({ message: 'Access denied: Students only' });
    }

    const student = await Student.findById(req.user.id);
    if (!student) {
      console.error('❌ Student not found:', req.user.id);
      return res.status(404).json({ message: 'Student not found' });
    }

    console.log('✅ Student found:', student.name, student.studentId);

    // Get student's team and current phase
    const team = await Team.findOne({
      'members.studentId': student.studentId
    });

    console.log('🔍 Team lookup result:', team ? `Found team: ${team.name}` : 'No team found');

    const currentPhase = team?.currentPhase || team?.phase || 'A';
    console.log('📊 Current phase:', currentPhase);

    // Build query for materials
    const query = {
      isActive: true,
      $or: [
        { targetType: 'all' },
        { targetType: 'phase', targetPhase: currentPhase },
        { targetType: 'teams', targetTeams: team?._id },
        { targetType: 'students', targetStudents: req.user.id }
      ]
    };

    console.log('🔎 Materials query:', JSON.stringify(query, null, 2));

    // Check if Material model exists
    console.log('📋 Material model exists:', !!Material);

    const materials = await Material.find(query)
      .populate('uploadedBy', 'name')
      .sort({ uploadDate: -1 });

    console.log('📁 Found materials count:', materials.length);

    res.json({
      success: true,
      materials,
      studentPhase: currentPhase,
      teamName: team?.name || null
    });

  } catch (error) {
    console.error('❌ Get student materials error:', error);
    console.error('❌ Error stack:', error.stack);
    res.status(500).json({ 
      message: 'Failed to fetch materials',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Server error'
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
// Update the existing /api/students/me endpoint
app.get('/api/students/me', authenticate, async (req, res) => {
  try {
    const student = await Student.findById(req.user.id)
      .select('name studentId email program completedCredits cgpa phone address enrolled avatar skills'); // Added skills
    
    if (!student) {
      return res.status(404).json({ message: 'Student not found' });
    }

    const studentTeam = await Team.findOne({
      'members.studentId': student.studentId
    });

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
      avatar: student.avatar,
      avatarUrl: student.avatar,
      skills: student.skills || [], // Include skills
      hasSpecialAccess: req.user.hasSpecialAccess || false,
      isEligible: req.user.isEligible || false,
      isInTeam: req.user.isInTeam || false,
      teamName: studentTeam?.name || null
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
  teamId: { type: mongoose.Schema.Types.ObjectId, ref: 'Team' }, // NEW: Reference to existing team
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
  senderSkills: [{ type: String }],
  senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
  targetStudentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
  targetStudentEmail: String,
  targetStudentName: String,
  message: String,
  requestType: { 
    type: String, 
    enum: ['new_team', 'join_existing'], 
    default: 'new_team' 
  }, // NEW: Track request type
  requiresLeaderApproval: { type: Boolean, default: false }, // NEW: Flag for leader approval
  leaderApprovalStatus: { 
    type: String, 
    enum: ['pending', 'approved', 'rejected'], 
    default: 'pending' 
  }, // NEW: Leader approval status
  status: { 
    type: String, 
    enum: ['pending', 'accepted', 'rejected', 'awaiting_leader'], 
    default: 'pending' 
  },
  sentDate: { type: Date, default: Date.now },
  responseDate: Date,
  leaderResponseDate: Date // NEW: Track when leader responds
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
  
  completedMilestones: [{ type: String }], // Array of milestone IDs
  progressStatus: { 
    type: String, 
    enum: ['On Track', 'Needs Improvement', 'Delayed', 'Completed', 'Not Set'], 
    default: 'Not Set' 
  },
  statusNotes: { type: String, default: '' },
  lastProgressUpdate: { type: Date },
  projectCompleted: { type: Boolean, default: false },
  projectCompletedDate: { type: Date },
  specialCase: { 
    type: Boolean, 
    default: false,
    description: 'Team locked by admin when supervisor assigned to incomplete team'
  },
  specialCaseReason: {
    type: String,
    default: null
  },

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
  enum: ['active', 'recruiting', 'inactive', 'hidden', 'completed'], 
  default: 'recruiting' 
},

  phase: { type: String, default: 'A' },
  currentPhase: { type: String, default: 'A' },
  phaseHistory: [{
    phase: { type: String, enum: ['A', 'B', 'C'] },
    startDate: { type: Date, default: Date.now },
    endDate: Date,
    updatedBy: { 
      facultyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Faculty' },
      facultyName: String
    },
    duration: Number // in days
  }],
  
  currentPhaseStartDate: { type: Date, default: Date.now },
  phaseUpdatedAt: { type: Date, default: Date.now },
  
  joinRequests: [{
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
    studentName: { type: String, required: true },
    message: String,
    avatar: String, // Base64 avatar data
    skills: [{ type: String }],
      studentName: { type: String, required: true },
  studentIdNumber: { type: String },
  completedCredits: { type: Number },
  program: { type: String },
    status: { type: String, enum: ['pending', 'accepted', 'rejected'], default: 'pending' },
    requestDate: { type: Date, default: Date.now }
  }],

  supervisionRequests: [{
    facultyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Faculty', required: true },
    facultyName: { type: String, required: true },
    facultyDepartment: { type: String },
    facultyEmail: { type: String },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
    requestedByName: { type: String, required: true },
    status: { 
      type: String, 
      enum: ['pending', 'accepted', 'rejected'], 
      default: 'pending' 
    },
    requestDate: { type: Date, default: Date.now },
    responseDate: { type: Date },
    message: { type: String }
  }],
  
  currentSupervisor: {
    facultyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Faculty' },
    facultyName: { type: String },
    facultyDepartment: { type: String },
    acceptedDate: { type: Date }
  },

  createdDate: { type: Date, default: Date.now },
  supervisor: { type: mongoose.Schema.Types.ObjectId, ref: 'Faculty' }
}, { timestamps: true });

// Add this to your server.js file

// Support Ticket Schema
const supportTicketSchema = new mongoose.Schema({
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
  studentName: { type: String, required: true },
  studentIdNumber: { type: String, required: true },
  studentEmail: { type: String, required: true },
  subject: { type: String, required: true },
  description: { type: String, required: true },
  category: { 
    type: String, 
    enum: ['Technical', 'Academic', 'Team', 'Account', 'Other'], 
    default: 'Other' 
  },
  priority: { 
    type: String, 
    enum: ['Low', 'Medium', 'High', 'Critical'], 
    default: 'Medium' 
  },
  status: { 
    type: String, 
    enum: ['Open', 'In Progress', 'Resolved', 'Closed'], 
    default: 'Open' 
  },
  adminResponse: { type: String, default: '' },
  adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
  adminName: { type: String },
  submittedAt: { type: Date, default: Date.now },
  respondedAt: { type: Date },
  resolvedAt: { type: Date }
}, { timestamps: true });

const SupportTicket = mongoose.model('SupportTicket', supportTicketSchema);

// API Endpoints for Support Tickets

// Submit support ticket (Student)
app.post('/api/support/submit', authenticate, async (req, res) => {
  try {
    const { subject, description, category, priority } = req.body;
    
    if (!subject || !description) {
      return res.status(400).json({ message: 'Subject and description are required' });
    }

    const student = await Student.findById(req.user.id);
    if (!student) {
      return res.status(404).json({ message: 'Student not found' });
    }

    const supportTicket = new SupportTicket({
      studentId: req.user.id,
      studentName: student.name,
      studentIdNumber: student.studentId,
      studentEmail: student.email,
      subject: subject.trim(),
      description: description.trim(),
      category: category || 'Other',
      priority: priority || 'Medium'
    });

    await supportTicket.save();

    res.status(201).json({
      success: true,
      message: 'Support ticket submitted successfully',
      ticketId: supportTicket._id
    });

  } catch (error) {
    console.error('Submit support ticket error:', error);
    res.status(500).json({ message: 'Server error while submitting ticket' });
  }
});

// Get student's support tickets
app.get('/api/support/my-tickets', authenticate, async (req, res) => {
  try {
    const tickets = await SupportTicket.find({
      studentId: req.user.id
    }).sort({ submittedAt: -1 });

    res.json({
      success: true,
      tickets
    });

  } catch (error) {
    console.error('Get student tickets error:', error);
    res.status(500).json({ message: 'Server error while fetching tickets' });
  }
});

// Get all support tickets (Admin)
app.get('/api/admin/support/tickets', authenticate, async (req, res) => {
  try {
    const { status, category, priority } = req.query;
    
    let filter = {};
    if (status && status !== 'all') filter.status = status;
    if (category && category !== 'all') filter.category = category;
    if (priority && priority !== 'all') filter.priority = priority;

    const tickets = await SupportTicket.find(filter)
      .sort({ submittedAt: -1 })
      .populate('studentId', 'name studentId email')
      .lean();

    res.json({
      success: true,
      tickets
    });

  } catch (error) {
    console.error('Get admin tickets error:', error);
    res.status(500).json({ message: 'Server error while fetching tickets' });
  }
});

// Update ticket status (Admin)
// Update ticket status (Admin) - IMPROVED VERSION
app.put('/api/admin/support/tickets/:ticketId/status', authenticate, async (req, res) => {
  try {
    const { ticketId } = req.params;
    const { status, adminResponse } = req.body;

    // Validate required fields
    if (!status) {
      return res.status(400).json({ message: 'Status is required' });
    }

    const updateData = { status };
    
    // Only update response fields if adminResponse is provided
    if (adminResponse && adminResponse.trim()) {
      updateData.adminResponse = adminResponse.trim();
      updateData.respondedAt = new Date();
    }
    
    // Set resolved date for final statuses
    if (status === 'Resolved' || status === 'Closed') {
      updateData.resolvedAt = new Date();
    }

    const ticket = await SupportTicket.findByIdAndUpdate(
      ticketId,
      updateData,
      { new: true }
    );

    if (!ticket) {
      return res.status(404).json({ message: 'Ticket not found' });
    }

    // ✅ IMPROVED: Better notification logic
    let notificationTitle = '';
    let notificationMessage = '';
    let notificationType = 'general';

    // Create appropriate notification based on status and whether response was provided
    if (adminResponse && adminResponse.trim()) {
      // Admin provided a response message
      notificationTitle = 'Support Ticket Response';
      notificationMessage = `Admin responded to your ticket "${ticket.subject}": ${adminResponse.substring(0, 100)}${adminResponse.length > 100 ? '...' : ''}`;
      notificationType = 'support_response';
    } else {
      // Admin only updated status without message
      switch (status) {
        case 'In Progress':
          notificationTitle = 'Support Ticket Update';
          notificationMessage = `Your support ticket "${ticket.subject}" is now being processed.`;
          notificationType = 'support_update';
          break;
        case 'Resolved':
          notificationTitle = 'Support Ticket Resolved';
          notificationMessage = `Your support ticket "${ticket.subject}" has been marked as resolved.`;
          notificationType = 'support_resolved';
          break;
        case 'Closed':
          notificationTitle = 'Support Ticket Closed';
          notificationMessage = `Your support ticket "${ticket.subject}" has been closed.`;
          notificationType = 'support_closed';
          break;
        default:
          notificationTitle = 'Support Ticket Status Update';
          notificationMessage = `Your support ticket "${ticket.subject}" status has been updated to: ${status}`;
          notificationType = 'support_update';
      }
    }

    // Create notification for the student
    if (notificationTitle) {
      const notification = new Notification({
        recipientId: ticket.studentId,
        type: notificationType,
        title: notificationTitle,
        message: notificationMessage,
        data: {
          ticketId: ticket._id,
          ticketSubject: ticket.subject,
          ticketStatus: status,
          adminResponse: adminResponse || null,
          category: ticket.category,
          priority: ticket.priority,
          hasResponse: !!(adminResponse && adminResponse.trim())
        },
        read: false,
        createdAt: new Date()
      });

      await notification.save();
      console.log(`📧 Support notification created for student ${ticket.studentId}: ${notificationTitle}`);

      // ✅ Send real-time notification if student is online
      if (userSockets && userSockets.has(ticket.studentId.toString())) {
        io.to(userSockets.get(ticket.studentId.toString())).emit('supportNotification', {
          type: notificationType,
          title: notificationTitle,
          message: notificationMessage,
          ticketId: ticket._id,
          status: status,
          hasResponse: !!(adminResponse && adminResponse.trim())
        });
      }
    }

    res.json({
      success: true,
      message: adminResponse 
        ? 'Ticket updated with response successfully' 
        : 'Ticket status updated successfully',
      ticket,
      hasResponse: !!(adminResponse && adminResponse.trim())
    });

  } catch (error) {
    console.error('Update ticket error:', error);
    res.status(500).json({ message: 'Server error while updating ticket' });
  }
});


// Delete ticket (Admin)
app.delete('/api/admin/support/tickets/:ticketId', authenticate, async (req, res) => {
  try {
    const { ticketId } = req.params;

    const ticket = await SupportTicket.findByIdAndDelete(ticketId);
    
    if (!ticket) {
      return res.status(404).json({ message: 'Ticket not found' });
    }

    res.json({
      success: true,
      message: 'Ticket deleted successfully'
    });

  } catch (error) {
    console.error('Delete ticket error:', error);
    res.status(500).json({ message: 'Server error while deleting ticket' });
  }
});


// Add this after your existing schemas
const supervisionRequestSchema = new mongoose.Schema({
  teamId: { type: mongoose.Schema.Types.ObjectId, ref: 'Team', required: true },
  facultyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Faculty', required: true },
  requesterId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
  teamName: { type: String, required: true },
  facultyName: { type: String, required: true },
  requesterName: { type: String, required: true },
  message: { type: String, required: true },
  status: { 
    type: String, 
    enum: ['pending', 'accepted', 'rejected'], 
    default: 'pending' 
  },
  requestDate: { type: Date, default: Date.now },
  responseDate: Date
}, { timestamps: true });

const SupervisionRequest = mongoose.model('SupervisionRequest', supervisionRequestSchema);


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

    const sender = await Student.findById(req.user.id).select('name studentId email program skills completedCredits'); // ✅ ADD skills
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
    const targetEmail = targetStudent.email; // get fresh from DB
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
      senderSkills: sender.skills || [],
      senderId: req.user.id,
      targetStudentId: targetStudentId,
      targetStudentEmail: targetEmail,  // always authoritative from DB
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
      message: `${sender.name} sent you a request to create team "${teamName}"`,
      targetEmail: targetEmail
    });

    // 📧 Send email invitation
    try {
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: "capstoneserverewu@gmail.com",
          pass: "ppry snhj xcuc zfdc", // Gmail app password
        },
      });

      const mailOptions = {
        from: '"Supervise Me" <capstoneserverewu@gmail.com>',
        to: targetEmail,
        subject: `Capstone Invitation: Join "${teamName}"`,
        html: `
          <p>Hi ${targetStudentName},</p>
          <p><strong>${sender.name}</strong> has invited you to join their Capstone team "<strong>${teamName}</strong>".</p>

      <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px; margin: 15px 0;">
      <h4>Inviter Details:</h4>
      <p><strong>Name:</strong> ${sender.name}</p>
      <p><strong>Student ID:</strong> ${sender.studentId}</p>
      ${sender.skills && sender.skills.length > 0 ? `
        <p><strong>Skills:</strong> ${sender.skills.join(', ')}</p>
      ` : ''}
      </div>

          <p>Login to the Capstone Portal to accept or reject the invitation:</p>
          <p><a href="${process.env.REACT_APP_CLIENT_URL || 'http://localhost:3000'}" target="_blank">Go to Portal</a></p>
          <hr/>
          <p>This is an automated email from the EWU Capstone System.</p>
        `,
      };

      await transporter.sendMail(mailOptions);
      console.log(`📧 Invitation email sent to ${targetStudentName} (${targetEmail})`);
    } catch (emailErr) {
      console.error('❌ Invitation email failed:', emailErr);
    }

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
// In server.js, around line 2280-2400, update the accept-request endpoint
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

    if (request.requestType === 'join_existing') {
      // For existing team requests, check if leader approval is needed
      if (request.requiresLeaderApproval) {
        // Mark as awaiting leader approval
        request.status = 'awaiting_leader';
        request.responseDate = new Date();
        await request.save();

        // Create notification for team leader
        const team = await Team.findById(request.teamId);
        const leader = team.members.find(m => m.role === 'Leader');
        if (leader) {
          const leaderStudent = await Student.findOne({ studentId: leader.studentId });
          if (leaderStudent) {
            const leaderNotification = new Notification({
              recipientId: leaderStudent._id,
              type: 'team_request',
              title: 'New Member Awaiting Approval',
              message: `${currentStudent.name} accepted the invitation to join your team "${team.name}" and is awaiting your approval.`,
              data: {
                requestId: request._id,
                studentName: currentStudent.name,
                teamName: team.name,
                senderName: request.senderName
              },
              read: false
            });
            await leaderNotification.save();
          }
        }

        return res.json({
          success: true,
          message: `Request accepted! Waiting for team leader approval to join "${request.teamName}".`,
          status: 'awaiting_leader'
        });
      }
    }

    const sender = await Student.findById(request.senderId);
    if (!sender) {
      return res.status(404).json({ message: 'Team creator not found' });
    }

    // Check if sender already has a team
    let senderTeam = await Team.findOne({
      'members.studentId': sender.studentId
    });

    if (senderTeam && senderTeam.members.length >= 4) {
      request.status = 'rejected';
      request.responseDate = new Date();
      await request.save();

      const notification = new Notification({
        recipientId: req.user.id,
        type: 'team_rejected',
        title: 'Team is Full',
        message: `Cannot join team "${senderTeam.name}" - team is already full (4/4 members). Your request has been automatically canceled.`,
        data: {
          teamId: senderTeam._id,
          teamName: senderTeam.name,
          reason: 'team_full'
        },
        read: false
      });
      await notification.save();

      return res.status(400).json({ 
        message: `Team "${senderTeam.name}" is already full (4/4 members). Cannot join.`,
        action: 'team_full',
        teamName: senderTeam.name,
        currentMembers: senderTeam.members.length,
        maxMembers: 4
      });
    }

    let finalTeam;

    if (!senderTeam) {
      // Create new team
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
        status: 'recruiting',
        memberCount: 2,
        maxMembers: 4,
        phase: 'A',
        currentPhase: 'A'
      });

      finalTeam = await newTeam.save();
      console.log(`✅ New team "${finalTeam.name}" created with 2 members`);

    } else {
      // Join existing team
      if (senderTeam.members.length >= 4) {
        request.status = 'rejected';
        request.responseDate = new Date();
        await request.save();

        return res.status(400).json({ 
          message: `Team "${senderTeam.name}" is full (4/4 members). Cannot join.`,
          action: 'team_full',
          teamName: senderTeam.name,
          currentMembers: senderTeam.members.length,
          maxMembers: 4
        });
      }

      const isAlreadyMember = senderTeam.members.some(member => 
        member.studentId === currentStudent.studentId
      );
      if (isAlreadyMember) {
        return res.status(400).json({ message: 'You are already a member of this team' });
      }

      senderTeam.members.push({
        studentId: currentStudent.studentId,
        name: currentStudent.name,
        email: currentStudent.email,
        program: currentStudent.program,
        role: 'Member'
      });
      
      senderTeam.memberCount = senderTeam.members.length;
      
      if (senderTeam.members.length >= 4) {
        senderTeam.status = 'active';
        console.log(`🎉 Team "${senderTeam.name}" is now full and active (4/4 members)`);
      }

      finalTeam = await senderTeam.save();
      console.log(`✅ ${currentStudent.name} joined existing team "${finalTeam.name}" (${finalTeam.members.length}/4 members)`);

    }

    
      let sentPendingRequests = [];
      let cancelledRequestsCount = 0;

    // ✅ NEW: Cancel all pending requests sent BY the accepting student
    try {
      console.log(`🚫 Canceling all pending invitations sent by ${currentStudent.name}...`);
      
      // Find all pending requests sent by the accepting student
      const sentPendingRequests = await TeamRequest.find({
        senderId: req.user.id,
        status: 'pending'
      });

      console.log(`Found ${sentPendingRequests.length} pending requests to cancel`);

      if (sentPendingRequests.length > 0) {
        // Cancel all pending requests sent by this student
        await TeamRequest.updateMany(
          {
            senderId: req.user.id,
            status: 'pending'
          },
          {
            status: 'cancelled',
            responseDate: new Date()
          }
        );

        // ✅ Send notifications to students whose invitations were canceled
        for (const pendingRequest of sentPendingRequests) {
          const targetStudent = await Student.findById(pendingRequest.targetStudentId);
          if (targetStudent) {
            const cancelNotification = new Notification({
              recipientId: pendingRequest.targetStudentId,
              type: 'team_rejected',
              title: 'Team Invitation Canceled',
              message: `${currentStudent.name}'s invitation to join team "${pendingRequest.teamName}" has been automatically canceled because they joined another team.`,
              data: {
                teamName: pendingRequest.teamName,
                senderName: currentStudent.name,
                reason: 'sender_joined_other_team',
                originalRequestId: pendingRequest._id
              },
              read: false
            });
            await cancelNotification.save();
          }
        }

        console.log(`✅ Canceled ${sentPendingRequests.length} pending invitations sent by ${currentStudent.name}`);
      }
    } catch (cancelError) {
      console.error('❌ Error canceling pending requests:', cancelError);
      // Don't fail the main operation if cancellation fails
    }

    // If team is now full (4 members), cancel all other pending invitations TO this team
    if (finalTeam.members.length >= 4) {
      try {
        console.log(`🚫 Team "${finalTeam.name}" is full, canceling remaining pending invitations...`);
        
        const pendingRequests = await TeamRequest.find({
          senderId: request.senderId,
          status: 'pending',
          _id: { $ne: requestId }
        });

        console.log(`Found ${pendingRequests.length} pending requests to cancel`);

        if (pendingRequests.length > 0) {
          await TeamRequest.updateMany(
            {
              senderId: request.senderId,
              status: 'pending',
              _id: { $ne: requestId }
            },
            {
              status: 'cancelled',
              responseDate: new Date()
            }
          );

          for (const pendingRequest of pendingRequests) {
            const cancelNotification = new Notification({
              recipientId: pendingRequest.targetStudentId,
              type: 'team_rejected',
              title: 'Team Invitation Canceled',
              message: `Your invitation to join team "${finalTeam.name}" has been automatically canceled because the team is now full (4/4 members).`,
              data: {
                teamId: finalTeam._id,
                teamName: finalTeam.name,
                reason: 'team_full_auto_cancel',
                originalRequestId: pendingRequest._id
              },
              read: false
            });
            await cancelNotification.save();
          }

          console.log(`✅ Canceled ${pendingRequests.length} pending invitations for full team "${finalTeam.name}"`);
        }
      } catch (cancelError) {
        console.error('❌ Error canceling pending requests:', cancelError);
      }
    }

    // Send acceptance email to sender
    try {
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: "capstoneserverewu@gmail.com",
          pass: "ppry snhj xcuc zfdc"
        },
      });

      const mailOptions = {
        from: '"Supervise Me" <capstoneserverewu@gmail.com>',
        to: sender.email,
        subject: `Team Member Added - ${currentStudent.name} joined "${finalTeam.name}"`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <h2 style="color: #10b981;">🎉 Great News!</h2>
            <p>Hi ${sender.name},</p>
            <p><strong>${currentStudent.name}</strong> has accepted your invitation and joined your CSE 400 team "<strong>${finalTeam.name}</strong>".</p>
            
            <div style="background-color: #f0fdf4; padding: 15px; border-radius: 5px; margin: 15px 0;">
              <h4 style="margin-top: 0;">📊 Team Status:</h4>
              <p><strong>Current Members:</strong> ${finalTeam.members.length}/4</p>
              <p><strong>Status:</strong> ${finalTeam.status === 'active' ? '✅ Team Complete & Active' : '🔄 Still Recruiting'}</p>
              ${finalTeam.members.length < 4 ? '<p><strong>Note:</strong> You can still invite more students until you reach 4 members!</p>' : '<p><strong>Congratulations!</strong> Your team is now complete with 4 members. All other pending invitations have been automatically canceled.</p>'}
            </div>
            
            <div style="background-color: #f8fafc; padding: 15px; border-radius: 5px; margin: 15px 0;">
              <h4>👥 Current Team Members:</h4>
              ${finalTeam.members.map(member => `<p>• ${member.name} (${member.role})</p>`).join('')}
            </div>
            
            <p><a href="${process.env.REACT_APP_CLIENT_URL || 'http://localhost:3000'}" style="background-color: #3b82f6; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; display: inline-block;">Go to Capstone Portal</a></p>
            
            <hr/>
            <p style="color: #666; font-size: 12px;">This is an automated email from the EWU Capstone System.</p>
          </div>
        `
      };

      await transporter.sendMail(mailOptions);
      console.log(`📧 Team update email sent to ${sender.email}`);
    } catch (emailErr) {
      console.error("❌ Failed to send team update email:", emailErr);
    }

    // Create success notification for sender
    const senderNotification = new Notification({
      recipientId: request.senderId,
      type: 'team_accepted',
      title: 'New Team Member Joined!',
      message: `${currentStudent.name} accepted your invitation and joined team "${finalTeam.name}"! (${finalTeam.members.length}/4 members)`,
      data: {
        teamId: finalTeam._id,
        teamName: finalTeam.name,
        newMember: currentStudent.name,
        currentMemberCount: finalTeam.members.length,
        isTeamFull: finalTeam.members.length >= 4
      },
      read: false
    });
    
    await senderNotification.save();

    // Update the request status to accepted
    request.status = 'accepted';
    request.responseDate = new Date();
    await request.save();

    console.log(`✅ Team request accepted successfully. Team now has ${finalTeam.members.length}/4 members`);

    res.json({
      success: true,
      message: `Successfully joined team "${finalTeam.name}"! (${finalTeam.members.length}/4 members)`,
      team: finalTeam,
      memberCount: finalTeam.members.length,
      isTeamFull: finalTeam.members.length >= 4,
      teamStatus: finalTeam.status,
      cancelledRequests: cancelledRequestsCount
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

    // 🔹 Create notification for the sender so they know it was declined
    const rejector = await Student.findById(req.user.id);
    const notification = new Notification({
      recipientId: request.senderId, // Notify the original sender
      type: 'team_rejected',
      title: 'Team Invitation Declined',
      message: `${rejector.name} has declined your invitation to join team "${request.teamName}".`,
      data: {
        teamName: request.teamName,
        rejectedBy: rejector.name,
        requestId: request._id
      },
      read: false,
      createdAt: new Date()
    });
    await notification.save();

try {
  const senderStudent = await Student.findById(request.senderId);
  if (senderStudent?.email) {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: "capstoneserverewu@gmail.com",
        pass: "ppry snhj xcuc zfdc", // Gmail app password (already used elsewhere)
      },
    });

    const mailOptions = {
      from: '"Supervise Me" <capstoneserverewu@gmail.com>',
      to: senderStudent.email,
      subject: `Invitation Rejected: ${request.teamName}`,
      html: `
        <p>Hi ${senderStudent.name},</p>
        <p><strong>${rejector.name}</strong> has declined your invitation to join the team "<strong>${request.teamName}</strong>".</p>
        <p>You can invite another student or browse available members in the Capstone Portal.</p>
        <hr>
        <p>This is an automated email from the EWU Capstone System.</p>
      `,
    };

    await transporter.sendMail(mailOptions);
    console.log(`📧 Rejection email sent to ${senderStudent.email}`);
  }
} catch (emailErr) {
  console.error('❌ Failed to send rejection email:', emailErr);
}

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
    // Only show teams that are not hidden by supervisors
const teams = await Team.find({
      status: { $in: ['recruiting', 'active'] },
      memberCount: { $lt: 4 },
      specialCase: { $ne: true }, // Add this filter to exclude full teams
      $or: [
        { supervisor: { $exists: false } },
        { visibleInJoinPage: { $ne: false } }
      ]
    }).sort({ createdDate: -1 }).lean();

    // Add avatar data for members
    const memberStudentIds = [...new Set(
      teams.flatMap(team => team.members.map(member => member.studentId))
    )];

    if (memberStudentIds.length > 0) {
      // ✅ UPDATE: Include skills in the select query
      const studentsWithDetails = await Student.find({
        studentId: { $in: memberStudentIds }
      }).select('studentId avatar skills name email program completedCredits'); // Added skills


const studentDetailsMap = new Map(
        studentsWithDetails.map(student => [student.studentId, {
          avatar: student.avatar,
          skills: student.skills || [], // ✅ ADD: Include skills
          name: student.name,
          email: student.email,
          program: student.program,
          completedCredits: student.completedCredits
        }])
      );

     teams.forEach(team => {
        team.members.forEach(member => {
          const studentDetails = studentDetailsMap.get(member.studentId);
          if (studentDetails) {
            member.avatar = studentDetails.avatar;
            member.avatarUrl = studentDetails.avatar;
            member.skills = studentDetails.skills || []; // ✅ ADD: Populate skills
            member.email = studentDetails.email || member.email;
            member.program = studentDetails.program || member.program;
            member.completedCredits = studentDetails.completedCredits;
          }
        });
      });
    }
    
    console.log('Found visible teams for join page:', teams.length);
    res.json(teams);
  } catch (error) {
    console.error('Get teams error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});


// Add this new endpoint in server.js
app.get('/api/admin/teams/special-case', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }

    const specialCaseTeams = await Team.find({
      specialCase: true
    }).populate('currentSupervisor.facultyId', 'name email department').lean();

    // Add member details
    const memberStudentIds = [...new Set(
      specialCaseTeams.flatMap(team => team.members.map(member => member.studentId))
    )];

    if (memberStudentIds.length > 0) {
      const studentsWithDetails = await Student.find({
        studentId: { $in: memberStudentIds }
      }).select('studentId name email program completedCredits cgpa avatar');

      const studentDetailsMap = new Map(
        studentsWithDetails.map(student => [student.studentId, student])
      );

      specialCaseTeams.forEach(team => {
        team.members.forEach(member => {
          const studentDetails = studentDetailsMap.get(member.studentId);
          if (studentDetails) {
            member.completedCredits = studentDetails.completedCredits;
            member.cgpa = studentDetails.cgpa;
            member.avatar = studentDetails.avatar;
          }
        });
      });
    }

    res.json({
      success: true,
      teams: specialCaseTeams,
      count: specialCaseTeams.length
    });

  } catch (error) {
    console.error('Get special case teams error:', error);
    res.status(500).json({ message: 'Server error while fetching special case teams' });
  }
});

// Add endpoint to unlock special case team
app.post('/api/admin/teams/:teamId/unlock-special-case', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }

    const { teamId } = req.params;
    const team = await Team.findById(teamId);

    if (!team) {
      return res.status(404).json({ message: 'Team not found' });
    }

    if (!team.specialCase) {
      return res.status(400).json({ message: 'Team is not a special case' });
    }

    // Unlock the team
    team.specialCase = false;
    team.specialCaseReason = null;
    team.status = team.members.length >= 4 ? 'active' : 'recruiting';
    
    await team.save();

    // Notify team members
    for (const member of team.members) {
      try {
        const student = await Student.findOne({ studentId: member.studentId });
        if (student) {
          const notification = new Notification({
            recipientId: student._id,
            recipientType: 'Student',
            type: 'general',
            title: 'Team Unlocked',
            message: `Administrator has unlocked your team "${team.name}". Your team can now accept new members.`,
            data: {
              teamId: team._id,
              teamName: team.name,
              action: 'team_unlocked'
            },
            read: false
          });
          await notification.save();
        }
      } catch (notifError) {
        console.error('Error creating notification:', notifError);
      }
    }

    res.json({
      success: true,
      message: `Team "${team.name}" has been unlocked from special case status`,
      team: team
    });

  } catch (error) {
    console.error('Unlock special case error:', error);
    res.status(500).json({ message: 'Server error while unlocking team' });
  }
});


// Get available students (not in any team) - Updated
// Replace the existing /api/students/available endpoint with this:
app.get('/api/students/available', authenticate, async (req, res) => {
  try {
    const currentStudentId = req.user.id;
    
    // Fetch dynamic config
    const config = await Config.findOne();
    const requiredCredits = config?.requiredCredits || 95;
    
    console.log(`Using dynamic credit requirement: ${requiredCredits}`);
    
    // Find all student IDs that are already members of any team
    const teams = await Team.find({}, 'members.studentId');
    const memberStudentIds = teams.flatMap(team => 
      team.members.map(member => member.studentId)
    );

    // Use dynamic credit requirement and include skills
    const availableStudents = await Student.find({
      _id: { $ne: currentStudentId },
      studentId: { $nin: memberStudentIds },
      status: 'Active',
      completedCredits: { $gte: requiredCredits }
    })
    .select('-password -resetToken -resetTokenExpiry') // This will include skills
    .sort({ name: 1 });

    console.log(`Found ${availableStudents.length} active students with ≥${requiredCredits} credits`);
    res.json(availableStudents);
  } catch (err) {
    console.error('Error fetching available students:', err);
    res.status(500).json({ message: 'Server error while fetching available students' });
  }
});


app.get('/api/students/deliverables', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'student') {
      return res.status(403).json({ message: 'Access denied: Students only' });
    }

    const student = await Student.findById(req.user.id);
    if (!student) {
      return res.status(404).json({ message: 'Student not found' });
    }

    // Find student's team
    const team = await Team.findOne({
      'members.studentId': student.studentId,
      'currentSupervisor.facultyId': { $exists: true }
    });

    if (!team) {
      return res.status(404).json({ 
        message: 'No supervised team found',
        hasTeam: false,
        hasSupervisor: false
      });
    }

    // Get deliverables for this team
    const deliverables = await Deliverable.find({
      teamId: team._id,
      isActive: true
    }).sort({ deadline: 1 });

    // Get submissions for each deliverable
    const deliverablesWithSubmissions = await Promise.all(
      deliverables.map(async (deliverable) => {
        const latestSubmission = await DeliverableSubmission.findOne({
          deliverableId: deliverable._id,
          teamId: team._id,
          isLatest: true
        }).populate('submittedBy', 'name studentId');

        return {
          ...deliverable.toObject(),
          submission: latestSubmission,
          isOverdue: new Date() > deliverable.deadline && !latestSubmission,
          canUpload: !latestSubmission || latestSubmission.status === 'needs_revision'
        };
      })
    );

    // Check if current user is team leader
    const teamMember = team.members.find(m => m.studentId === student.studentId);
    const isLeader = teamMember?.role === 'Leader';

    res.json({
      success: true,
      deliverables: deliverablesWithSubmissions,
      team: {
        name: team.name,
        supervisor: team.currentSupervisor.facultyName
      },
      isLeader,
      hasTeam: true,
      hasSupervisor: true
    });

  } catch (error) {
    console.error('Get student deliverables error:', error);
    res.status(500).json({ message: 'Server error while fetching deliverables' });
  }
});

// NEW: Get finalized grades for student
app.get('/api/students/finalized-grades', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'student') {
      return res.status(403).json({ message: 'Access denied: Students only' });
    }

    const student = await Student.findById(req.user.id);
    if (!student) {
      return res.status(404).json({ message: 'Student not found' });
    }

    // Find all finalized evaluations for this student
    const finalizedEvaluations = await BoardEvaluation.find({
      status: 'finalized',
      'finalResults.individualResults.studentId': student.studentId
    })
    .populate('boardId', 'name')
    .populate('teamId', 'name')
    .sort({ 'adminReview.finalizedAt': -1 });

    const grades = finalizedEvaluations.map(evaluation => {
      const studentResult = evaluation.finalResults.individualResults.find(
        result => result.studentId === student.studentId
      );

      if (!studentResult) return null;

      return {
        phase: evaluation.phase,
        teamId: evaluation.teamId._id,
        teamName: evaluation.teamId.name,
        boardName: evaluation.boardId.name,
        finalMark: studentResult.finalMark,
        grade: studentResult.grade,
        gpa: studentResult.gpa,
        isModified: studentResult.isModified || false,
        modificationReason: studentResult.modificationReason,
        breakdown: studentResult.breakdown,
        finalizedAt: evaluation.adminReview.finalizedAt
      };
    }).filter(grade => grade !== null);

    res.json({
      success: true,
      grades: grades
    });

  } catch (error) {
    console.error('Get finalized grades error:', error);
    res.status(500).json({ message: 'Server error while fetching grades' });
  }
});

// Get student's finalized grades (my-grades endpoint)
app.get('/api/students/my-grades', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'student') {
      return res.status(403).json({ message: 'Access denied: Students only' });
    }

    const student = await Student.findById(req.user.id);
    if (!student) {
      return res.status(404).json({ message: 'Student not found' });
    }

    // Find all finalized evaluations for this student
    const finalizedEvaluations = await BoardEvaluation.find({
      status: 'finalized',
      'finalResults.individualResults.studentId': student.studentId
    })
    .populate('boardId', 'name')
    .populate('teamId', 'name')
    .sort({ 'adminReview.finalizedAt': -1 });

    const grades = finalizedEvaluations.map(evaluation => {
      const studentResult = evaluation.finalResults.individualResults.find(
        result => result.studentId === student.studentId
      );

      if (!studentResult) return null;

      return {
        phase: evaluation.phase,
        teamId: evaluation.teamId._id,
        teamName: evaluation.teamId.name,
        boardName: evaluation.boardId.name,
        finalMark: studentResult.finalMark,
        grade: studentResult.grade,
        gpa: studentResult.gpa,
        isModified: studentResult.isModified || false,
        modificationReason: studentResult.modificationReason,
        breakdown: studentResult.breakdown,
        finalizedAt: evaluation.adminReview.finalizedAt
      };
    }).filter(grade => grade !== null);

    res.json({
      success: true,
      grades: grades
    });

  } catch (error) {
    console.error('Get student grades error:', error);
    res.status(500).json({ message: 'Server error while fetching grades' });
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

    if (team.specialCase) {
      return res.status(403).json({ 
        message: `This team is locked as a special case by administration. Only admins can manage membership.`,
        action: 'special_case_blocked',
        specialCase: true
      });
    }

   const student = await Student.findById(req.user.id).select('name studentId email program completedCredits avatar skills'); // ✅ ADD skills
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
      avatar: student.avatar,  
      skills: student.skills || [],                   // ADD: Avatar
      status: 'pending'
    });

    await team.save();


    // ✅ ADD EMAIL NOTIFICATION TO TEAM LEADER
    try {
      // Find team leader
      const teamLeader = team.members.find(member => member.role === 'Leader');
      if (teamLeader) {
        const leaderStudent = await Student.findOne({ studentId: teamLeader.studentId });
        
        if (leaderStudent?.email) {
          const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
              user: "capstoneserverewu@gmail.com",
              pass: "ppry snhj xcuc zfdc",
            },
          });

          const mailOptions = {
            from: '"Supervise Me" <capstoneserverewu@gmail.com>',
            to: leaderStudent.email,
            subject: `New Join Request for Team "${team.name}"`,
            html: `
              <p>Hi ${teamLeader.name},</p>
              <p><strong>${student.name}</strong> (${student.studentId}) has requested to join your CSE 400 team "<strong>${team.name}</strong>".</p>
              
              <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px; margin: 15px 0;">
                <h4>Student Details:</h4>
                <p><strong>Name:</strong> ${student.name}</p>
                <p><strong>Student ID:</strong> ${student.studentId}</p>
                <p><strong>Program:</strong> ${student.program}</p>
                <p><strong>Completed Credits:</strong> ${student.completedCredits}</p>
                <p><strong>Message:</strong> ${message || 'No message provided'}</p>
              </div>
              
              <p>Please login to the Capstone Portal to accept or decline this request:</p>
              <p><a href="${process.env.REACT_APP_CLIENT_URL || 'http://localhost:3000'}" target="_blank">Go to Capstone Portal</a></p>
              
              <hr/>
              <p>This is an automated email from the EWU Capstone System.</p>
            `,
          };

          await transporter.sendMail(mailOptions);
          console.log(`📧 Join request email sent to team leader: ${leaderStudent.email}`);
        }
      }
    } catch (emailErr) {
      console.error('❌ Failed to send join request email:', emailErr);
      // Don't fail the request if email fails
    }

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

// Admin endpoint to mark team as special case
app.put('/api/admin/teams/:teamId/special-case', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied: Admin only' });
    }

    const { teamId } = req.params;
    const { specialCase, reason } = req.body;

    const team = await Team.findById(teamId);
    if (!team) {
      return res.status(404).json({ message: 'Team not found' });
    }

    // Update special case status
    team.specialCase = specialCase;
    team.specialCaseReason = specialCase ? reason : null;
    
    if (specialCase) {
      team.status = 'active'; // When marked as special case, set to active
    } else {
      team.status = 'recruiting'; // When unmarked, set to recruiting
    }

    await team.save();

    // Notify team members about special case status change
    const teamMemberStudents = await Student.find({
      studentId: { $in: team.members.map(m => m.studentId) }
    });

    for (const student of teamMemberStudents) {
      const notification = new Notification({
        recipientId: student._id,
        recipientType: 'Student',
        type: 'general',
        title: specialCase ? 'Team Marked as Special Case' : 'Special Case Status Removed',
        message: specialCase 
          ? `Your team "${team.name}" has been marked as a special case by admin. ${reason ? `Reason: ${reason}` : ''}`
          : `Your team "${team.name}" is no longer marked as a special case.`,
        data: {
          teamId: team._id,
          teamName: team.name,
          specialCase: specialCase,
          reason: reason,
          status: team.status,
          action: 'special_case_update'
        },
        read: false
      });
      await notification.save();
    }

    res.json({
      success: true,
      message: `Team ${specialCase ? 'marked as' : 'unmarked from'} special case successfully`,
      team: {
        id: team._id,
        name: team.name,
        specialCase: team.specialCase,
        specialCaseReason: team.specialCaseReason,
        status: team.status,
      }
    });

  } catch (error) {
    console.error('Special case update error:', error);
    res.status(500).json({ message: 'Server error while updating special case status' });
  }
});

// Add endpoint to unlock special case team
app.post('/api/admin/teams/:teamId/unlock-special-case', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }

    const { teamId } = req.params;
    const team = await Team.findById(teamId);

    if (!team) {
      return res.status(404).json({ message: 'Team not found' });
    }

    if (!team.specialCase) {
      return res.status(400).json({ message: 'Team is not a special case' });
    }

    // Unlock the team
    team.specialCase = false;
    team.specialCaseReason = null;
    team.status = 'recruiting'; // ✅ CHANGED: Always set to recruiting when unlocked
    
    await team.save();

    // Notify team members
    for (const member of team.members) {
      try {
        const student = await Student.findOne({ studentId: member.studentId });
        if (student) {
          const notification = new Notification({
            recipientId: student._id,
            recipientType: 'Student',
            type: 'general',
            title: 'Team Unlocked',
            message: `Administrator has unlocked your team "${team.name}". Your team is now recruiting and can accept new members.`,
            data: {
              teamId: team._id,
              teamName: team.name,
              action: 'team_unlocked',
              status: 'recruiting' // ✅ Include new status
            },
            read: false
          });
          await notification.save();
        }
      } catch (notifError) {
        console.error('Error creating notification:', notifError);
      }
    }

    res.json({
      success: true,
      message: `Team "${team.name}" has been unlocked from special case status and is now recruiting`,
      team: team
    });

  } catch (error) {
    console.error('Unlock special case error:', error);
    res.status(500).json({ message: 'Server error while unlocking team' });
  }
});


// Modified faculty supervised teams endpoint to only show special-case teams
app.get('/api/faculty/supervised-teams', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'faculty') {
      return res.status(403).json({ message: 'Access denied: Faculty only' });
    }

    // Only show special-case teams for faculty
    const supervisedTeams = await Team.find({
      supervisor: req.user.id,
      'currentSupervisor.facultyId': req.user.id
      //  specialCase: true // ✅ NEW: Only show special-case teams
    }).lean();

    // Get detailed student information for each team
    const teamsWithDetails = await Promise.all(
      supervisedTeams.map(async (team) => {
        const memberStudentIds = team.members.map(member => member.studentId);
        const studentsWithDetails = await Student.find({
          studentId: { $in: memberStudentIds }
        }).select('studentId name email program completedCredits cgpa avatar phone');

        const studentDetailsMap = new Map(
          studentsWithDetails.map(student => [student.studentId, student])
        );

        const enhancedMembers = team.members.map(member => {
          const studentDetails = studentDetailsMap.get(member.studentId);
          return {
            ...member,
            email: studentDetails?.email || 'Not available',
            program: studentDetails?.program || 'Not specified',
            completedCredits: studentDetails?.completedCredits || 0,
            cgpa: studentDetails?.cgpa || 0.0,
            avatar: studentDetails?.avatar || null,
            phone: studentDetails?.phone || 'Not available'
          };
        });

        const validCGPAs = enhancedMembers.filter(m => m.cgpa > 0).map(m => m.cgpa);
        const averageCGPA = validCGPAs.length > 0 ? 
          validCGPAs.reduce((sum, cgpa) => sum + cgpa, 0) / validCGPAs.length : 0;

          
           const recentMessageCount = await ChatMessage.countDocuments({
          teamId: team._id,
          senderType: 'student',
          timestamp: { $gt: new Date(Date.now() - 24 * 60 * 60 * 1000) }
        });


        // Get latest message
        const latestMessage = await ChatMessage.findOne({ teamId: team._id })
          .sort({ timestamp: -1 })
          .lean();

        return {
          ...team,
          members: enhancedMembers,
          averageCGPA: averageCGPA.toFixed(2),
          totalCompletedCredits: enhancedMembers.reduce((sum, member) => sum + (member.completedCredits || 0), 0),
          isVisible: team.status !== 'hidden',
          canReceiveRequests: team.status === 'recruiting' || team.status === 'active',
          isSpecialCase: team.specialCase || false,
          recentMessageCount: recentMessageCount, // ✅ CHANGED
          hasRecentMessages: recentMessageCount > 0, // ✅ CHANGED
          latestMessage: latestMessage ? {
            text: latestMessage.message || 'File shared',
            senderName: latestMessage.senderName,
            timestamp: latestMessage.timestamp,
            senderType: latestMessage.senderType
          } : null
        };
      })
    );

const teamsWithRecentMessages = teamsWithDetails.filter(team => team.hasRecentMessages).length;

    res.json({
      success: true,
      teams: teamsWithDetails,
      totalTeams: teamsWithDetails.length,
      message: teamsWithDetails.length === 0 ? 'No special-case teams assigned to you' : undefined,
teamsWithRecentMessages: teamsWithRecentMessages 
    });

  } catch (error) {
    console.error('Get supervised teams error:', error);
    res.status(500).json({ message: 'Server error while fetching supervised teams' });
  }
});


// NEW: Add endpoint to mark team messages as read
app.post('/api/faculty/teams/:teamId/mark-read', authenticate, async (req, res) => {
  try {
    const { teamId } = req.params;
    
    if (req.user.role !== 'faculty') {
      return res.status(403).json({ message: 'Access denied: Faculty only' });
    }

    const team = await Team.findById(teamId);
    if (!team) {
      return res.status(404).json({ message: 'Team not found' });
    }

    // Verify faculty is the supervisor
    if (!team.currentSupervisor || team.currentSupervisor.facultyId.toString() !== req.user.id) {
      return res.status(403).json({ message: 'You are not the supervisor of this team' });
    }

    // Mark all unread student messages as read by this faculty
    const result = await ChatMessage.updateMany(
      {
        teamId: teamId,
        senderType: 'student',
        'readBy.facultyId': { $ne: req.user.id }
      },
      {
        $push: {
          readBy: {
            facultyId: req.user.id,
            readAt: new Date()
          }
        }
      }
    );

    res.json({
      success: true,
      message: 'Messages marked as read',
      markedCount: result.modifiedCount
    });

  } catch (error) {
    console.error('Mark messages as read error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});


// Handle join request
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
      const requestingStudent = await Student.findById(joinRequest.studentId);
        
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
// 📧 NEW: Send acceptance email notification
      try {
        const requestingStudent = await Student.findById(joinRequest.studentId);
       const transporter = require('nodemailer').createTransport({
      service: 'gmail',
      auth: {
        user: "capstoneserverewu@gmail.com",
        pass: "ppry snhj xcuc zfdc", // Your Gmail App Password
      },
    });

        const mailOptions = {
          from: '"Supervise Me" <capstoneserverewu@gmail.com>',
          to: requestingStudent.email,
          subject: `✅ Join Request Accepted - Welcome to Team "${team.name}"!`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f9f9f9;">
              <div style="background-color: #ffffff; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
                <div style="text-align: center; margin-bottom: 30px;">
                  <h1 style="color: #10b981; margin-bottom: 10px;">🎉 Join Request Accepted!</h1>
                  <div style="width: 60px; height: 4px; background-color: #10b981; margin: 0 auto;"></div>
                </div>
                
                <div style="background-color: #f0fdf4; padding: 20px; border-radius: 6px; border-left: 4px solid #10b981; margin-bottom: 25px;">
                  <h2 style="color: #065f46; margin-top: 0;">Welcome to Team "${team.name}"!</h2>
                  <p style="color: #047857; margin-bottom: 0;">Your join request has been accepted by team leader <strong>${student.name}</strong>.</p>
                </div>

                <div style="margin-bottom: 25px;">
                  <h3 style="color: #374151; margin-bottom: 15px;">Team Details:</h3>
                  <div style="background-color: #f8fafc; padding: 15px; border-radius: 6px;">
                    <p style="margin: 5px 0;"><strong>Team Name:</strong> ${team.name}</p>
                    <p style="margin: 5px 0;"><strong>Major:</strong> ${team.major}</p>
                    <p style="margin: 5px 0;"><strong>Course:</strong> CSE 400 Capstone Project</p>
                    <p style="margin: 5px 0;"><strong>Current Members:</strong> ${team.members.length}/4</p>
                    <p style="margin: 5px 0;"><strong>Team Leader:</strong> ${student.name}</p>
                    ${team.projectIdea ? `<p style="margin: 5px 0;"><strong>Project:</strong> ${team.projectIdea}</p>` : ''}
                  </div>
                </div>

                <div style="margin-bottom: 25px;">
                  <h3 style="color: #374151; margin-bottom: 15px;">What's Next?</h3>
                  <ul style="color: #4b5563; padding-left: 20px;">
                    <li style="margin-bottom: 8px;">Login to the Capstone Portal to access your team</li>
                    <li style="margin-bottom: 8px;">Start collaborating with your team members in the team chat</li>
                    <li style="margin-bottom: 8px;">Coordinate on your CSE 400 project planning and development</li>
                    <li style="margin-bottom: 8px;">Work together to find a faculty supervisor</li>
                  </ul>
                </div>

                <div style="text-align: center; margin-bottom: 25px;">
                  <a href="${process.env.REACT_APP_CLIENT_URL || 'http://localhost:3000'}" 
                     style="display: inline-block; background-color: #3b82f6; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold;">
                    Go to Capstone Portal
                  </a>
                </div>

                <div style="border-top: 1px solid #e5e7eb; padding-top: 20px; text-align: center;">
                  <p style="color: #6b7280; font-size: 14px; margin: 0;">
                    This is an automated email from the EWU Capstone System.
                  </p>
                </div>
              </div>
            </div>
          `,
        };

        await transporter.sendMail(mailOptions);
        console.log(`📧 Join request acceptance email sent to ${requestingStudent.email}`);
      } catch (emailErr) {
        console.error('❌ Failed to send acceptance email:', emailErr);
        // Don't fail the request if email fails
      }

      console.log(`✅ ${requestingStudent.name} accepted into team ${team.name}`);

    } else if (status === 'rejected') {
      joinRequest.status = 'rejected';

      // Add this line before using requestingStudent in the rejection email section
const requestingStudent = await Student.findById(joinRequest.studentId);
if (!requestingStudent) {
  return res.status(404).json({ message: 'Requesting student not found' });
}

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

      // 🔹 ADD THE SOCKET EMISSION HERE 🔹
      if (userSockets && userSockets.has(joinRequest.studentId.toString())) {
        io.to(userSockets.get(joinRequest.studentId.toString())).emit('requestRejected', {
          teamId: teamId,
          rejectionCount: rejectionRecord.rejectionCount,
          canRetry: rejectionRecord.rejectionCount < 3,
          clearPendingStatus: true // Add this flag
        });
      }
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
          rejectionCount: rejectionRecord.rejectionCount < 3 
        },
        read: false
      });
      
      await notification.save();

      // ✅ NEW: Send real-time update to student to clear pending status
  if (userSockets && userSockets.has(joinRequest.studentId.toString())) {
    io.to(userSockets.get(joinRequest.studentId.toString())).emit('requestRejected', {
      teamId: teamId,
      rejectionCount: rejectionRecord.rejectionCount,
      canRetry: rejectionRecord.rejectionCount < 3
    });
  }

   console.log(`❌ ${joinRequest.studentName} rejected from team ${team.name} (${rejectionRecord.rejectionCount}/3 rejections)`);

      // 📧 NEW: Send rejection email notification
      try {
        const transporter = nodemailer.createTransport({
          service: 'gmail',
          auth: {
            user: "capstoneserverewu@gmail.com",
            pass: "ppry snhj xcuc zfdc", // Your Gmail App Password
          },
        });

        const isBlocked = rejectionRecord.rejectionCount >= 3;

        const mailOptions = {
          from: '"Supervise Me" <capstoneserverewu@gmail.com>',
          to: requestingStudent.email,
          subject: `❌ Join Request Declined - Team "${team.name}"`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f9f9f9;">
              <div style="background-color: #ffffff; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
                <div style="text-align: center; margin-bottom: 30px;">
                  <h1 style="color: #ef4444; margin-bottom: 10px;">Join Request Declined</h1>
                  <div style="width: 60px; height: 4px; background-color: #ef4444; margin: 0 auto;"></div>
                </div>
                
                <div style="background-color: #fef2f2; padding: 20px; border-radius: 6px; border-left: 4px solid #ef4444; margin-bottom: 25px;">
                  <h2 style="color: #7f1d1d; margin-top: 0;">Request Not Accepted</h2>
                  <p style="color: #991b1b; margin-bottom: 0;">
                    Your request to join team "<strong>${team.name}</strong>" has been declined by team leader <strong>${student.name}</strong>.
                  </p>
                </div>

                <div style="margin-bottom: 25px;">
                  <h3 style="color: #374151; margin-bottom: 15px;">Team Information:</h3>
                  <div style="background-color: #f8fafc; padding: 15px; border-radius: 6px;">
                    <p style="margin: 5px 0;"><strong>Team Name:</strong> ${team.name}</p>
                    <p style="margin: 5px 0;"><strong>Major:</strong> ${team.major}</p>
                    <p style="margin: 5px 0;"><strong>Team Leader:</strong> ${student.name}</p>
                    <p style="margin: 5px 0;"><strong>Rejection Count:</strong> ${rejectionRecord.rejectionCount}/3</p>
                  </div>
                </div>

                ${isBlocked ? `
                  <div style="background-color: #fef2f2; padding: 20px; border-radius: 6px; border: 1px solid #fecaca; margin-bottom: 25px;">
                    <h3 style="color: #7f1d1d; margin-top: 0;">❌ Request Limit Reached</h3>
                    <p style="color: #991b1b; margin-bottom: 0;">
                      You have reached the maximum number of requests (3) for this team. You can no longer send join requests to "<strong>${team.name}</strong>".
                    </p>
                  </div>
                ` : `
                  <div style="background-color: #fffbeb; padding: 20px; border-radius: 6px; border: 1px solid #fed7aa; margin-bottom: 25px;">
                    <h3 style="color: #92400e; margin-top: 0;">💡 You Can Try Again</h3>
                    <p style="color: #b45309; margin-bottom: 0;">
                      You have ${3 - rejectionRecord.rejectionCount} more attempt${3 - rejectionRecord.rejectionCount !== 1 ? 's' : ''} to request joining this team.
                    </p>
                  </div>
                `}

                <div style="margin-bottom: 25px;">
                  <h3 style="color: #374151; margin-bottom: 15px;">What's Next?</h3>
                  <ul style="color: #4b5563; padding-left: 20px;">
                    ${!isBlocked ? '<li style="margin-bottom: 8px;">You can send another request to this team later</li>' : ''}
                    <li style="margin-bottom: 8px;">Browse other available teams looking for members</li>
                    <li style="margin-bottom: 8px;">Create your own team and invite other students</li>
                    <li style="margin-bottom: 8px;">Check your team formation requirements and eligibility</li>
                  </ul>
                </div>

                <div style="text-align: center; margin-bottom: 25px;">
                  <a href="${process.env.REACT_APP_CLIENT_URL || 'http://localhost:3000'}" 
                     style="display: inline-block; background-color: #3b82f6; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold;">
                    Back to Capstone Portal
                  </a>
                </div>

                <div style="border-top: 1px solid #e5e7eb; padding-top: 20px; text-align: center;">
                  <p style="color: #6b7280; font-size: 14px; margin: 0;">
                    This is an automated email from the EWU Capstone System.<br>
                    If you have any questions, please contact your course instructor.
                  </p>
                </div>
              </div>
            </div>
          `,
        };

        await transporter.sendMail(mailOptions);
        console.log(`📧 Join request rejection email sent to ${requestingStudent.email}`);
      } catch (emailErr) {
        console.error('❌ Failed to send rejection email:', emailErr);
        // Don't fail the request if email fails
      }

      console.log(`❌ ${requestingStudent.name} rejected from team ${team.name} (${rejectionRecord.rejectionCount}/3 rejections)`);

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


// NEW: Get team's sent requests (for all team members to view)
// NEW: Get team's sent requests (for all team members to view)
app.get('/api/teams/team-requests', authenticate, async (req, res) => {
  try {
    const student = await Student.findById(req.user.id);
    if (!student) {
      return res.status(404).json({ message: 'Student not found' });
    }

    // Get user's team
    const team = await Team.findOne({
      'members.studentId': student.studentId
    });

    if (!team) {
      return res.status(404).json({ message: 'You are not in a team' });
    }

    // Get all requests sent by team members
    const teamRequests = await TeamRequest.find({
      teamId: team._id,
      requestType: 'join_existing'
    })
    .populate('targetStudentId', 'name studentId email program')
    .populate('senderId', 'name studentId')
    .sort({ sentDate: -1 });

    // Format requests with additional info
   const validRequests = teamRequests
      .filter(request => request.targetStudentId && request.senderId) // Filter out null references
      .map(request => ({
        _id: request._id,
        targetStudent: {
          _id: request.targetStudentId._id,
          name: request.targetStudentName || request.targetStudentId.name,
          studentId: request.targetStudentId.studentId,
          email: request.targetStudentId.email,
          program: request.targetStudentId.program
        },
        senderInfo: {
          _id: request.senderId._id,
          name: request.senderName || request.senderId.name,
          studentId: request.senderId.studentId
        },
        status: request.status,
        requiresLeaderApproval: request.requiresLeaderApproval,
        leaderApprovalStatus: request.leaderApprovalStatus,
        sentDate: request.sentDate,
        responseDate: request.responseDate,
        leaderResponseDate: request.leaderResponseDate,
        message: request.message
      }));

    res.json({
      success: true,
      requests: validRequests,
      team: {
        id: team._id,
        name: team.name,
        memberCount: team.members.length
      }
    });

  } catch (error) {
    console.error('Get team requests error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});



// Get individual team by ID (MISSING ENDPOINT)
app.get('/api/teams/:teamId', authenticate, async (req, res) => {
  try {
    const { teamId } = req.params;
    
     if (!mongoose.Types.ObjectId.isValid(teamId)) {
      return res.status(400).json({ 
        message: 'Invalid team ID format',
        error: 'Team ID must be a valid MongoDB ObjectId' 
      });
    }
    
    const team = await Team.findById(teamId).lean();
    if (!team) {
      return res.status(404).json({ message: 'Team not found' });
    }

    // Include avatar data for join requests
   if (team.joinRequests && team.joinRequests.length > 0) {
      const studentIds = team.joinRequests.map(req => req.studentId);
      const studentsWithFullData = await Student.find({
        _id: { $in: studentIds }
      }).select('_id studentId completedCredits program avatar name skills');
      
      const studentDataMap = new Map(
        studentsWithFullData.map(s => [s._id.toString(), {
          avatar: s.avatar,
          studentIdNumber: s.studentId,
          completedCredits: s.completedCredits,
          program: s.program,
          name: s.name,
          skills: s.skills || []
        }])
      );
      
      team.joinRequests.forEach(request => {
        const studentData = studentDataMap.get(request.studentId.toString());
        if (studentData) {
          request.avatar = request.avatar || studentData.avatar;
          request.studentIdNumber = request.studentIdNumber || studentData.studentIdNumber;
          request.completedCredits = request.completedCredits || studentData.completedCredits;
          request.program = request.program || studentData.program;
          request.skills = studentData.skills;
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
// Remove team member (with supervisor check)
app.post('/api/teams/:teamId/remove-member', authenticate, async (req, res) => {
  try {
    const { teamId } = req.params;
    const { memberStudentId } = req.body;

    const team = await Team.findById(teamId);
    if (!team) {
      return res.status(404).json({ message: 'Team not found' });
    }

    const currentUser = await Student.findById(req.user.id);
    
    // ✅ NEW: Check if team has a supervisor
    if (team.currentSupervisor && team.currentSupervisor.facultyId) {
      return res.status(403).json({ 
        message: `Only your supervisor ${team.currentSupervisor.facultyName} can remove team members. Contact your supervisor for member management.`,
        action: 'supervisor_required',
        supervisorName: team.currentSupervisor.facultyName
      });
    }

    // Original leader check (only applies if no supervisor)
    const leader = team.members.find(member => member.role === 'Leader');
    if (!leader || leader.studentId !== currentUser.studentId) {
      return res.status(403).json({ message: 'Only team leaders can remove members' });
    }

    // Rest of the original logic...
    if (team.members.length <= 2) {
      return res.status(400).json({ 
        message: 'Cannot remove members when team has 2 or fewer members. Use dismiss team instead.',
        action: 'dismiss_required'
      });
    }

    if (memberStudentId === currentUser.studentId && team.members.length > 1) {
      return res.status(400).json({ 
        message: 'Leaders cannot remove themselves. Transfer leadership first or dismiss the team.'
      });
    }

    // Remove the member
    team.members = team.members.filter(member => member.studentId !== memberStudentId);
    team.memberCount = team.members.length;
    
    if (team.members.length < 4) {
      team.status = 'recruiting';
    }

    await team.save();

     const removedStudent = await Student.findOne({ studentId: memberStudentId });
    if (removedStudent) {
      const notification = new Notification({
        recipientId: removedStudent._id,
        type: 'general',
        title: 'Removed from Team',
        message: `You have been removed from team "${team.name}" by team leader ${currentUser.name}.`,
        data: {
          teamId: team._id,
          teamName: team.name,
          removedBy: currentUser.name,
          action: 'member_removal'
        },
        read: false
      });
      await notification.save();
    }

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

// Remove team member by supervisor
app.post('/api/faculty/teams/:teamId/remove-member', authenticate, async (req, res) => {
  try {
    const { teamId } = req.params;
    const { memberStudentId, reason } = req.body;

    if (req.user.role !== 'faculty') {
      return res.status(403).json({ message: 'Access denied: Faculty only' });
    }

    const team = await Team.findById(teamId);
    if (!team) {
      return res.status(404).json({ message: 'Team not found' });
    }

    // ✅ Verify faculty is the supervisor
    if (!team.currentSupervisor || team.currentSupervisor.facultyId.toString() !== req.user.id) {
      return res.status(403).json({ message: 'You are not the supervisor of this team' });
    }

    const student = await Student.findOne({ studentId: memberStudentId });
    if (!student) {
      return res.status(404).json({ message: 'Student not found' });
    }

    // ✅ Find member to remove
    const memberIndex = team.members.findIndex(member => member.studentId === memberStudentId);
    if (memberIndex === -1) {
      return res.status(404).json({ message: 'Student is not a member of this team' });
    }

    const removedMember = team.members[memberIndex];
    team.members.splice(memberIndex, 1);
    team.memberCount = team.members.length;

    // ✅ Handle empty team
    if (team.members.length === 0) {
      await Team.findByIdAndDelete(teamId);
      
      // Notify the removed student
      const notification = new Notification({
        recipientId: student._id,
        recipientType: 'Student',
        type: 'general',
        title: 'Team Dissolved',
        message: `You were removed from team "${team.name}" by supervisor. The team has been dissolved as no members remain.`,
        data: {
          teamName: team.name,
          action: 'team_dissolved',
          reason: reason || null
        },
        read: false
      });
      await notification.save();

      return res.json({
        success: true,
        message: `${student.name} removed and team "${team.name}" dissolved`,
        teamDeleted: true
      });
    }

    // ✅ Handle leadership transfer if leader was removed
    if (removedMember.role === 'Leader' && team.members.length > 0) {
      team.members[0].role = 'Leader';
      
      // Notify new leader
      const newLeader = await Student.findOne({ studentId: team.members.studentId });
      if (newLeader) {
        const leaderNotification = new Notification({
          recipientId: newLeader._id,
          type: 'general',
          title: 'You Are Now Team Leader',
          message: `You have been made the leader of team "${team.name}" after the previous leader was removed by supervisor.`,
          data: {
            teamId: team._id,
            teamName: team.name,
            action: 'leadership_assigned'
          },
          read: false
        });
        await leaderNotification.save();
      }
    }

    // ✅ Update team status based on member count
    if (team.members.length < 4 && team.status === 'active') {
      team.status = 'recruiting';
    }

    await team.save();

    // ✅ Create notifications for all affected parties
    const faculty = await Faculty.findById(req.user.id);
    
    // Notify removed student
    const removedNotification = new Notification({
      recipientId: student._id,
      recipientType: 'Student',
      type: 'general',
      title: 'Removed from Team by Supervisor',
      message: `You have been removed from team "${team.name}" by your supervisor ${faculty.name}.${reason ? ` Reason: ${reason}` : ''}`,
      data: {
        teamId: team._id,
        teamName: team.name,
        removedBy: faculty.name,
        reason: reason || null,
        action: 'supervisor_removal'
      },
      read: false
    });
    await removedNotification.save();

    // Notify remaining team members
    const remainingStudents = await Student.find({
      studentId: { $in: team.members.map(m => m.studentId) }
    });

    for (const remainingStudent of remainingStudents) {
      const teamNotification = new Notification({
        recipientId: remainingStudent._id,
        type: 'general',
        title: 'Team Member Removed by Supervisor',
        message: `${student.name} has been removed from your team "${team.name}" by supervisor ${faculty.name}.`,
        data: {
          teamId: team._id,
          teamName: team.name,
          removedMember: student.name,
          supervisorName: faculty.name,
          action: 'member_removed_by_supervisor'
        },
        read: false
      });
      await teamNotification.save();
    }

    res.json({
      success: true,
      message: `${student.name} has been removed from team "${team.name}"`,
      memberCount: team.members.length,
      newLeader: removedMember.role === 'Leader' ? team.members[0]?.name : null,
      teamStatus: team.status,
      reason: reason || null
    });

  } catch (error) {
    console.error('Supervisor remove member error:', error);
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


    // ✅ FIX: Define targetStudentDoc BEFORE using it
const targetStudentDoc = await Student.findOne({ studentId: memberStudentId });
if (!targetStudentDoc) {
  return res.status(404).json({ message: 'Target student not found in database' });
}

    // ✅ NEW: Create in-app notification for the new leader
const leaderNotification = new Notification({
  recipientId: targetStudentDoc._id, // sending to the new leader
  type: 'general', // or make a new type 'leadership_transfer'
  title: 'You are now the Team Leader',
  message: `You have been made the leader of team "${team.name}" by ${currentUser.name}.`,
  data: {
    teamId: team._id,
    teamName: team.name,
    previousLeader: currentUser.name,
    action: 'leadership_transfer'
  },
  read: false,
  createdAt: new Date()
});

await leaderNotification.save();
console.log(`📢 Notification created for new leader: ${targetStudentDoc.name}`);

     // 📧 Send email notification to the new leader
    try {
      const targetStudentDoc = await Student.findOne({ studentId: memberStudentId });
      if (targetStudentDoc?.email) {
        const transporter = require('nodemailer').createTransport({
          service: 'gmail',
          auth: {
            user: "capstoneserverewu@gmail.com",
            pass: "ppry snhj xcuc zfdc" // your Gmail App Password
          },
        });

        const mailOptions = {
          from: '"Supervise Me" <capstoneserverewu@gmail.com>',
          to: targetStudentDoc.email,
          subject: `You are now the Team Leader of "${team.name}"`,
          html: `
            <p>Hi ${targetStudentDoc.name},</p>
            <p><strong>${currentUser.name}</strong> has made you the new leader of the team "<strong>${team.name}</strong>".</p>
            <p>You now have full privileges to manage your team, accept join requests, and coordinate with faculty.</p>
            <p><a href="${process.env.REACT_APP_CLIENT_URL || 'http://localhost:3000'}">Go to the Capstone Portal</a></p>
            <hr/>
            <p>This is an automated email from the EWU Capstone System.</p>
          `
        };

        await transporter.sendMail(mailOptions);
        console.log(`📧 Leadership transfer email sent to ${targetStudentDoc.email}`);
      }
    } catch (emailErr) {
      console.error("❌ Failed to send leader email notification:", emailErr);
    }

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
// Dismiss entire team (updated with supervisor check)
app.post('/api/teams/:teamId/dismiss', authenticate, async (req, res) => {
  try {
    const { teamId } = req.params;

    const team = await Team.findById(teamId);
    if (!team) {
      return res.status(404).json({ message: 'Team not found' });
    }

    const currentUser = await Student.findById(req.user.id);
    
    // ✅ NEW: Check if team has a supervisor
    if (team.currentSupervisor && team.currentSupervisor.facultyId) {
      return res.status(403).json({ 
        message: `This team is supervised by ${team.currentSupervisor.facultyName}. Only the supervisor can dismiss the team.`,
        action: 'supervisor_required',
        supervisorName: team.currentSupervisor.facultyName
      });
    }

    // Check if user is team leader (only applies if no supervisor)
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



// Get team phase information
app.get('/api/teams/:teamId/phase', authenticate, async (req, res) => {
  try {
    const { teamId } = req.params;
    const team = await Team.findById(teamId).select('currentPhase phase name');
    
    if (!team) {
      return res.status(404).json({ message: 'Team not found' });
    }

    res.json({
      success: true,
      phase: {
        current: team.currentPhase || team.phase || 'A',
        name: getPhaseDescription(team.currentPhase || team.phase || 'A'),
        teamName: team.name
      }
    });
  } catch (error) {
    console.error('Get phase error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.put('/api/faculty/teams/:teamId/phase', authenticate, async (req, res) => {
  try {
    const { teamId } = req.params;
    const { phase } = req.body;

    if (req.user.role !== 'faculty') {
      return res.status(403).json({ message: 'Access denied: Faculty only' });
    }

    const validPhases = ['A', 'B', 'C'];
    if (!validPhases.includes(phase)) {
      return res.status(400).json({ message: 'Invalid phase' });
    }

    const team = await Team.findById(teamId);
    if (!team) {
      return res.status(404).json({ message: 'Team not found' });
    }

    if (!team.currentSupervisor || team.currentSupervisor.facultyId.toString() !== req.user.id) {
      return res.status(403).json({ message: 'You are not the supervisor of this team' });
    }

    const faculty = await Faculty.findById(req.user.id);
    const previousPhase = team.currentPhase || team.phase || 'A';
    const now = new Date();
    
    // Calculate duration of previous phase
    const previousPhaseStartDate = team.currentPhaseStartDate || team.createdDate || new Date();
    const previousPhaseDuration = Math.floor((now - previousPhaseStartDate) / (1000 * 60 * 60 * 24));

    // Update phase history - close previous phase
    if (!team.phaseHistory) {
      team.phaseHistory = [];
    }

    // Close the current phase in history
    const currentPhaseInHistory = team.phaseHistory.find(p => p.phase === previousPhase && !p.endDate);
    if (currentPhaseInHistory) {
      currentPhaseInHistory.endDate = now;
      currentPhaseInHistory.duration = previousPhaseDuration;
    } else {
      // Add the previous phase to history if it doesn't exist
      team.phaseHistory.push({
        phase: previousPhase,
        startDate: previousPhaseStartDate,
        endDate: now, // ✅ IMPORTANT: Set end date for previous phase
        duration: previousPhaseDuration,
        updatedBy: {
          facultyId: faculty._id,
          facultyName: faculty.name
        }
      });
    }


    // Add new phase to history
    team.phaseHistory.push({
      phase: phase,
      startDate: now,
      updatedBy: {
        facultyId: faculty._id,
        facultyName: faculty.name
      }
    });

    // Update current phase info
    team.currentPhase = phase;
    team.phase = phase;
    team.currentPhaseStartDate = now;
    team.phaseUpdatedAt = now;

      team.completedMilestones = [];
    await team.save();

    // Create notifications for team members
    const teamMemberStudents = await Student.find({
      studentId: { $in: team.members.map(m => m.studentId) }
    });

    const phaseDescriptions = {
      "A": "Research & Planning Phase",
      "B": "Development & Implementation Phase", 
      "C": "Testing & Final Presentation Phase"
    };

    for (const student of teamMemberStudents) {
      const notification = new Notification({
        recipientId: student._id,
        recipientType: 'Student',
        type: 'general',
        title: 'Team Phase Updated',
        message: `Your supervisor ${faculty.name} has moved your team "${team.name}" from Phase ${previousPhase} to Phase ${phase} (${phaseDescriptions[phase]}).`,
        data: {
          teamId: team._id,
          teamName: team.name,
          supervisorName: faculty.name,
          previousPhase: previousPhase,
          newPhase: phase,
          phaseStartDate: now,
          action: 'phase_update'
        },
        read: false
      });
      await notification.save();
    }

    res.json({
      success: true,
      message: `Team phase updated to ${phase} successfully`,
      team: {
        id: team._id,
        name: team.name,
        previousPhase: previousPhase,
        newPhase: phase,
        phaseStartDate: now,
        phaseDuration: previousPhaseDuration
      }
    });

  } catch (error) {
    console.error('Update team phase error:', error);
    res.status(500).json({ message: 'Server error while updating team phase' });
  }
});


// Helper function for phase descriptions
const getPhaseDescription = (phase) => {
  const descriptions = {
    "A": "Research & Planning Phase",
    "B": "Development & Implementation Phase", 
    "C": "Testing & Final Presentation Phase"
  };
  return descriptions[phase] || "Unknown Phase";
};

// Update team schema to ensure proper phase handling
const updateTeamSchema = async () => {
  try {
    // Set default phase A for teams that don't have it
    await Team.updateMany(
      { $or: [{ currentPhase: { $exists: false } }, { currentPhase: null }] },
      { $set: { currentPhase: 'A', phase: 'A' } }
    );
    console.log('✅ Team phases updated to default A');
  } catch (error) {
    console.error('❌ Error updating team phases:', error);
  }
};




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


// Replace around line 2800-2900
app.get('/api/teams/requests/incoming', authenticate, async (req, res) => {
  try {
    const cacheKey = `requests_${req.user.id}`;
    const cached = requestCache.get(cacheKey);
    
    if (cached && (Date.now() - cached.timestamp) < 1000) {
      return res.json(cached.data);
    }
    
    const requests = await TeamRequest.find({
      targetStudentId: req.user.id,
      status: 'pending'
    })
    .populate('senderId', 'name studentId email')
    .sort({ sentDate: -1 });

    // ✅ FIX: Filter out requests with null sender
    const validRequests = requests.filter(request => 
      request.senderId && request.senderId._id
    );

    requestCache.set(cacheKey, {
      data: validRequests,
      timestamp: Date.now()
    });
    
    res.json(validRequests);
  } catch (error) {
    console.error('Get incoming requests error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});



// Send a chat message
// Send a chat message with file support
// Updated: Send a chat message (supports both students and faculty)
app.post('/api/teams/:teamId/messages', authenticate, async (req, res) => {
  try {
    const { teamId } = req.params;
    const { message, messageType = 'text', file } = req.body;

    const team = await Team.findById(teamId);
    if (!team) {
      return res.status(404).json({ message: 'Team not found' });
    }

    let isAuthorized = false;
    let senderData = {};

    if (req.user.role === 'student') {
      // Check if student is a team member
      const student = await Student.findById(req.user.id);
      const isMember = team.members.some(member => member.studentId === student.studentId);
      
      if (isMember) {
        isAuthorized = true;
        senderData = {
          senderId: req.user.id,
          senderName: student.name,
          senderIdentifier: student.studentId,
          senderType: 'student'
        };
      }
    } else if (req.user.role === 'faculty') {
      // Check if faculty is the team supervisor
      const faculty = await Faculty.findById(req.user.id);
      const isSupervisor = team.currentSupervisor && 
                          team.currentSupervisor.facultyId.toString() === req.user.id;
      
      if (isSupervisor) {
        isAuthorized = true;
        senderData = {
          senderId: req.user.id,
          senderName: faculty.name,
          senderIdentifier: faculty.email,
          senderType: 'faculty'
        };
      }
    }

    if (!isAuthorized) {
      return res.status(403).json({ message: 'You are not authorized to chat in this team' });
    }

    // Create new message
    const chatMessage = new ChatMessage({
      teamId,
      ...senderData,
      message: message || '',
      messageType: messageType || 'text',
      file: file || null
    });

    await chatMessage.save();

    // Populate sender info for response
    const populatedMessage = await ChatMessage.findById(chatMessage._id);

    res.status(201).json({
      success: true,
      message: populatedMessage
    });

  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Updated: Get chat messages (supports both students and faculty)
app.get('/api/teams/:teamId/messages', authenticate, async (req, res) => {
  try {
    const { teamId } = req.params;
    const { page = 1, limit = 50 } = req.query;

    const team = await Team.findById(teamId);
    if (!team) {
      return res.status(404).json({ message: 'Team not found' });
    }

    let isAuthorized = false;

    if (req.user.role === 'student') {
      const student = await Student.findById(req.user.id);
      const isMember = team.members.some(member => member.studentId === student.studentId);
      isAuthorized = isMember;
    } else if (req.user.role === 'faculty') {
      const isSupervisor = team.currentSupervisor && 
                          team.currentSupervisor.facultyId.toString() === req.user.id;
      isAuthorized = isSupervisor;
    }

    if (!isAuthorized) {
      return res.status(403).json({ message: 'You are not authorized to view this chat' });
    }

    // Get messages with pagination
    const messages = await ChatMessage.find({ teamId })
      .sort({ timestamp: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    // Reverse to show oldest first
    const sortedMessages = messages.reverse();

    if (req.user.role === 'faculty') {
      await ChatMessage.updateMany(
        {
          teamId: teamId,
          senderType: 'student',
          'readBy.facultyId': { $ne: req.user.id }
        },
        {
          $push: {
            readBy: {
              facultyId: req.user.id,
              readAt: new Date()
            }
          }
        }
      );
    }

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

// Get teams supervised by faculty (for chat access)
app.get('/api/faculty/my-supervised-teams', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'faculty') {
      return res.status(403).json({ message: 'Access denied: Faculty only' });
    }

    const supervisedTeams = await Team.find({
      'currentSupervisor.facultyId': req.user.id
    }).lean();

    // Add member count and latest message info
    const teamsWithDetails = await Promise.all(
      supervisedTeams.map(async (team) => {
        // Get latest message for each team
        const latestMessage = await ChatMessage.findOne({ teamId: team._id })
          .sort({ timestamp: -1 })
          .lean();

        // Get unread message count for faculty
        const unreadCount = await ChatMessage.countDocuments({
          teamId: team._id,
          timestamp: { $gt: new Date(Date.now() - 24 * 60 * 60 * 1000) }, // Last 24 hours as example
          senderType: 'student' // Only count student messages as unread for faculty
        });

        return {
          ...team,
          memberCount: team.members?.length || 0,
          latestMessage: latestMessage ? {
            text: latestMessage.message || 'File shared',
            senderName: latestMessage.senderName,
            timestamp: latestMessage.timestamp,
            senderType: latestMessage.senderType
          } : null,
          unreadCount
        };
      })
    );

    res.json({
      success: true,
      teams: teamsWithDetails
    });

  } catch (error) {
    console.error('Get supervised teams error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Faculty endpoint to get team details for chat
app.get('/api/faculty/team-chat/:teamId', authenticate, async (req, res) => {
  try {
    const { teamId } = req.params;
    
    if (req.user.role !== 'faculty') {
      return res.status(403).json({ message: 'Access denied: Faculty only' });
    }

    const team = await Team.findById(teamId);
    if (!team) {
      return res.status(404).json({ message: 'Team not found' });
    }

    // Verify faculty is the supervisor
    if (!team.currentSupervisor || team.currentSupervisor.facultyId.toString() !== req.user.id) {
      return res.status(403).json({ message: 'You are not the supervisor of this team' });
    }

    // Get student details for team members
    const memberStudentIds = team.members.map(member => member.studentId);
    const studentsWithDetails = await Student.find({
      studentId: { $in: memberStudentIds }
    }).select('studentId name email program avatar');

    const studentDetailsMap = new Map(
      studentsWithDetails.map(student => [student.studentId, student])
    );

    const enhancedMembers = team.members.map(member => {
      const studentDetails = studentDetailsMap.get(member.studentId);
      return {
        ...member,
        email: studentDetails?.email || 'Not available',
        program: studentDetails?.program || 'Not specified',
        avatar: studentDetails?.avatar || null
      };
    });

    res.json({
      success: true,
      team: {
        ...team.toObject(),
        members: enhancedMembers
      }
    });

  } catch (error) {
    console.error('Get team chat error:', error);
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


// Admin route to get all teams
app.get('/api/admin/teams', authenticate, async (req, res) => {
  try {
    const teams = await Team.find({})
      .sort({ createdDate: -1 })
      .lean();

    // Get student details for each team member
    for (let team of teams) {
      const memberStudentIds = team.members.map(member => member.studentId);
      const studentsWithAvatars = await Student.find({
        studentId: { $in: memberStudentIds }
      }).select('studentId avatar completedCredits cgpa');

      const avatarMap = new Map(
        studentsWithAvatars.map(s => [s.studentId, {
          avatar: s.avatar,
          completedCredits: s.completedCredits,
          cgpa: s.cgpa
        }])
      );

      team.members.forEach(member => {
        const studentData = avatarMap.get(member.studentId);
        if (studentData) {
          member.avatar = studentData.avatar;
          member.completedCredits = studentData.completedCredits;
          member.cgpa = studentData.cgpa;
        }
      });
    }

    res.json(teams);
  } catch (err) {
    console.error('Error fetching teams:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Admin route to delete a team
app.delete('/api/admin/teams/:teamId', authenticate, async (req, res) => {
  try {
    const { teamId } = req.params;
    
    const deletedTeam = await Team.findByIdAndDelete(teamId);
    
    if (!deletedTeam) {
      return res.status(404).json({ message: 'Team not found' });
    }

    res.json({ message: 'Team deleted successfully' });
  } catch (err) {
    console.error('Error deleting team:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ===== AUTOMATIC GROUP CREATION SYSTEM =====
// Add this section after your API routes but before server startup

const getCurrentSemester = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1; // 0-based to 1-based
  
  // More accurate semester determination
  if (month >= 1 && month <= 4) {
    return `Spring ${year}`;
  } else if (month >= 5 && month <= 8) {
    return `Summer ${year}`;
  } else {
    return `Fall ${year}`;
  }
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
          recipientId: student._id,  
          recipientType: 'Student',      // ✅ Changed from studentId to recipientId
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
        recipientId: student._id,  
        recipientType: 'Student',        // ✅ Changed from studentId to recipientId
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

// Admin endpoint to add member to any team (bypasses 4-member limit)
app.post('/api/admin/teams/:teamId/add-member', authenticate, async (req, res) => {
  try {
    const { teamId } = req.params;
    const { studentId, forceAdd = false } = req.body; // Add forceAdd parameter

    // Find the team
    const team = await Team.findById(teamId);
    if (!team) {
      return res.status(404).json({ message: 'Team not found' });
    }

    // Find the student
    const student = await Student.findById(studentId);
    if (!student) {
      return res.status(404).json({ message: 'Student not found' });
    }

    // Check eligibility but allow override with forceAdd
    const config = await Config.findOne();
    const requiredCredits = config?.requiredCredits || 95;
    const isEligible = student.completedCredits >= requiredCredits;

    if (!isEligible && !forceAdd) {
      return res.status(400).json({ 
        message: `${student.name} has only ${student.completedCredits} credits (requires ${requiredCredits}). Use "Force Add" to add anyway.`,
        requiresForceAdd: true,
        studentInfo: {
          name: student.name,
          studentId: student.studentId,
          completedCredits: student.completedCredits,
          requiredCredits: requiredCredits,
          creditsNeeded: requiredCredits - student.completedCredits
        }
      });
    }

    // Check if student is already in ANY team
    const existingTeam = await Team.findOne({
      'members.studentId': student.studentId
    });
    
    if (existingTeam) {
      // If student is in the same team, return error
      if (existingTeam._id.toString() === teamId) {
        return res.status(400).json({ 
          message: `${student.name} is already a member of this team` 
        });
      }
      
      // If student is in different team, remove from old team first
      await Team.findByIdAndUpdate(existingTeam._id, {
        $pull: { members: { studentId: student.studentId } },
        $inc: { memberCount: -1 }
      });

      // Update old team status if needed
      const oldTeam = await Team.findById(existingTeam._id);
      if (oldTeam.members.length < 4) {
        oldTeam.status = 'recruiting';
        await oldTeam.save();
      }

      console.log(`Admin moved ${student.name} from team "${existingTeam.name}" to team "${team.name}"`);
    }

    // Add student to the new team (bypassing 4-member limit)
    const newMember = {
      studentId: student.studentId,
      name: student.name,
      email: student.email,
      program: student.program,
      role: 'Member', // Admin-added members are regular members
      joinedDate: new Date(),
      addedByAdmin: true, // Mark as admin-added
      eligibleAtTimeOfAdd: isEligible // Track eligibility at time of addition
    };

    team.members.push(newMember);
    team.memberCount = team.members.length;

    // Update team status based on member count
    if (team.members.length >= 4) {
      team.status = 'active';
    } else {
      team.status = 'recruiting';
    }

    await team.save();

 const notification = new Notification({
      recipientId: student._id,
      recipientType: 'Student',
      type: 'general',
      title: isEligible ? 'Added to Team by Admin' : 'Added to Team by Admin (Special Access)',
      message: isEligible 
        ? `You have been added to team "${team.name}" by an administrator.`
        : `You have been granted special access and added to team "${team.name}" by an administrator. You can now login to the portal.`,
      data: {
        teamId: team._id,
        teamName: team.name,
        addedBy: 'Administrator',
        action: 'admin_add',
        specialAccess: !isEligible
      },
      read: false
    });
    
    await notification.save();

    // Return updated team with avatar data
    const updatedTeam = await Team.findById(teamId).lean();
    const memberStudentIds = updatedTeam.members.map(member => member.studentId);
    const studentsWithAvatars = await Student.find({
      studentId: { $in: memberStudentIds }
    }).select('studentId avatar completedCredits');
    
    const avatarMap = new Map(
      studentsWithAvatars.map(s => [s.studentId, {
        avatar: s.avatar,
        completedCredits: s.completedCredits
      }])
    );
    
    updatedTeam.members.forEach(member => {
      const studentData = avatarMap.get(member.studentId);
      if (studentData) {
        member.avatar = studentData.avatar;
        member.completedCredits = studentData.completedCredits;
        member.avatarUrl = member.avatar;
      }
    });

    console.log(`✅ Admin successfully added ${student.name} to team "${team.name}" (${team.members.length} members)${!isEligible ? ' [SPECIAL ACCESS GRANTED]' : ''}`);

     res.json({
      success: true,
      message: isEligible 
        ? `${student.name} has been added to team "${team.name}"`
        : `${student.name} has been added to team "${team.name}" with special access (ineligible student)`,
      team: updatedTeam,
      memberCount: team.members.length,
      isOverCapacity: team.members.length > 4,
      specialAccess: !isEligible
    });

  } catch (error) {
    console.error('Admin add member error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Add this new endpoint for admin to get ALL students
app.get('/api/admin/students/all-students', authenticate, async (req, res) => {
  try {
    const config = await Config.findOne();
    const requiredCredits = config?.requiredCredits || 95;
    
    // Get ALL active students regardless of eligibility
    const students = await Student.find({
      status: 'Active'
    })
    .select('_id name studentId email program completedCredits cgpa avatar')
    .sort({ name: 1 });

    // Add team and eligibility information
    const studentsWithInfo = await Promise.all(
      students.map(async (student) => {
        const team = await Team.findOne({
          'members.studentId': student.studentId
        }).select('_id name status memberCount');

        const isEligible = student.completedCredits >= requiredCredits;

        return {
          ...student.toObject(),
          isEligible,
          eligibilityStatus: isEligible ? 'Eligible' : 'Ineligible',
          creditsNeeded: isEligible ? 0 : (requiredCredits - student.completedCredits),
          currentTeam: team ? {
            id: team._id,
            name: team.name,
            status: team.status,
            memberCount: team.memberCount
          } : null
        };
      })
    );

    res.json({
      success: true,
      students: studentsWithInfo,
      totalStudents: students.length,
      eligibleCount: studentsWithInfo.filter(s => s.isEligible).length,
      ineligibleCount: studentsWithInfo.filter(s => !s.isEligible).length,
      requiredCredits: requiredCredits
    });

  } catch (error) {
    console.error('Get all students error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Replace the existing endpoint in server.js
app.get('/api/admin/students/all-active', authenticate, async (req, res) => {
  try {
    // ✅ Get dynamic configuration for required credits
    const config = await Config.findOne();
    const requiredCredits = config?.requiredCredits || 95;
    
    // Get all active students with eligibility check
    const students = await Student.find({
      status: 'Active'
    })
    .select('_id name studentId email program completedCredits cgpa avatar')
    .sort({ name: 1 });

    // Filter students and add eligibility status
    const studentsWithTeamAndEligibility = await Promise.all(
      students.map(async (student) => {
        const team = await Team.findOne({
          'members.studentId': student.studentId
        }).select('_id name status memberCount');

        const isEligible = student.completedCredits >= requiredCredits;

        return {
          ...student.toObject(),
          isEligible,
          currentTeam: team ? {
            id: team._id,
            name: team.name,
            status: team.status,
            memberCount: team.memberCount
          } : null
        };
      })
    );

    // ✅ Filter to show only eligible students for team addition
    const eligibleStudents = studentsWithTeamAndEligibility.filter(s => s.isEligible);

    res.json({
      success: true,
      students: eligibleStudents,
      totalStudents: students.length,
      eligibleCount: eligibleStudents.length,
      requiredCredits: requiredCredits
    });

  } catch (error) {
    console.error('Get all students error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});


// Add this new endpoint in server.js
app.get('/api/admin/students/eligible-for-capstone', authenticate, async (req, res) => {
  try {
    const config = await Config.findOne();
    const requiredCredits = config?.requiredCredits || 95;
    
    const eligibleStudents = await Student.find({
      status: 'Active',
      completedCredits: { $gte: requiredCredits }
    })
    .select('_id name studentId email program completedCredits cgpa avatar')
    .sort({ name: 1 });

    // Get team information for each eligible student
    const studentsWithTeamInfo = await Promise.all(
      eligibleStudents.map(async (student) => {
        const team = await Team.findOne({
          'members.studentId': student.studentId
        }).select('_id name status memberCount');

        return {
          ...student.toObject(),
          isEligible: true,
          currentTeam: team ? {
            id: team._id,
            name: team.name,
            status: team.status,
            memberCount: team.memberCount
          } : null
        };
      })
    );

    console.log(`Found ${eligibleStudents.length} Capstone-eligible students (≥${requiredCredits} credits)`);

    res.json({
      success: true,
      students: studentsWithTeamInfo,
      eligibleCount: eligibleStudents.length,
      requiredCredits: requiredCredits,
      message: `Showing only students with ≥${requiredCredits} completed credits`
    });

  } catch (error) {
    console.error('Get eligible students error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});


// Admin endpoint to remove member from team (no restrictions) - FIXED VERSION
app.delete('/api/admin/teams/:teamId/remove-member/:studentId', authenticate, async (req, res) => {
  try {
    const { teamId, studentId } = req.params;

    const team = await Team.findById(teamId);
    if (!team) {
      return res.status(404).json({ message: 'Team not found' });
    }

    // ✅ FIX: Use studentId field instead of _id for lookup
    const student = await Student.findOne({ studentId: studentId });
    if (!student) {
      return res.status(404).json({ message: 'Student not found' });
    }

    // Remove the member using studentId field (not ObjectId)
    const memberIndex = team.members.findIndex(member => member.studentId === studentId);
    if (memberIndex === -1) {
      return res.status(404).json({ message: 'Student is not a member of this team' });
    }

    const removedMember = team.members[memberIndex];
    team.members.splice(memberIndex, 1);
    team.memberCount = team.members.length;

    // Update team status
    if (team.members.length === 0) {
      // If no members left, delete the team
      await Team.findByIdAndDelete(teamId);
      return res.json({
        success: true,
        message: `${student.name} removed and team "${team.name}" deleted (no members remaining)`,
        teamDeleted: true
      });
    } else {
      // If leader was removed, assign new leader
      if (removedMember.role === 'Leader' && team.members.length > 0) {
        team.members[0].role = 'Leader';
      }

      // Update status based on member count
      if (team.members.length < 4) {
        team.status = 'recruiting';
      }

      await team.save();
    }

    // Create notification for removed student
    const notification = new Notification({
      recipientId: student._id, 
      recipientType: 'Student', // ✅ Use student._id for notification
      type: 'general',
      title: 'Removed from Team by Admin',
      message: `You have been removed from team "${team.name}" by an administrator.`,
      data: {
        teamId: team._id,
        teamName: team.name,
        removedBy: 'Administrator'
      },
      read: false
    });
    
    await notification.save();

    console.log(`✅ Admin removed ${student.name} from team "${team.name}"`);

    res.json({
      success: true,
      message: `${student.name} has been removed from team "${team.name}"`,
      memberCount: team.members.length
    });

  } catch (error) {
    console.error('Admin remove member error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});


// Get sent team requests for a user (outgoing requests)
app.get('/api/teams/requests/sent', authenticate, async (req, res) => {
  try {
    const sentRequests = await TeamRequest.find({
      senderId: req.user.id,
      status: 'pending'
    })
    .populate('targetStudentId', 'name studentId email program')
    .sort({ sentDate: -1 });

    // Format the response to match frontend expectations
    const formattedRequests = sentRequests.map(request => ({
      id: request._id,
      studentId: request.targetStudentId._id,
      studentName: request.targetStudentName,
      studentIdNumber: request.targetStudentId.studentId,
      studentEmail: request.targetStudentEmail,
      studentProgram: request.targetStudentId.program,
      teamName: request.teamName,
      status: request.status,
      sentDate: request.sentDate,
      teamData: request.teamData
    }));

    console.log(`Found ${formattedRequests.length} sent requests for user ${req.user.id}`);
    res.json(formattedRequests);
  } catch (error) {
    console.error('Get sent requests error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});


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

// Add this endpoint in your server.js
// Replace your existing /api/supervision/request endpoint with this enhanced version
// app.post('/api/supervision/request', authenticate, async (req, res) => {
//   try {
//     const { facultyId, message } = req.body;
    
//     if (!facultyId || !message) {
//       return res.status(400).json({ message: 'Faculty ID and message are required' });
//     }

//     const student = await Student.findById(req.user.id);
//     if (!student) {
//       return res.status(404).json({ message: 'Student not found' });
//     }

//     // Check if student is in a team
//     const team = await Team.findOne({
//       'members.studentId': student.studentId
//     });

//     if (!team) {
//       return res.status(403).json({ message: 'You must be in a team to request supervision' });
//     }

//     // Check if user is team leader
//     const teamMember = team.members.find(member => member.studentId === student.studentId);
//     if (!teamMember || teamMember.role !== 'Leader') {
//       return res.status(403).json({ message: 'Only team leaders can send supervision requests' });
//     }

//     // Check if faculty exists and is visible to students
//     const faculty = await Faculty.findById(facultyId);
//     if (!faculty) {
//       return res.status(404).json({ message: 'Faculty not found' });
//     }

//     if (!faculty.visibleToStudents) {
//       return res.status(403).json({ message: 'This faculty is not available for supervision requests' });
//     }

//     // Check if already sent request to this faculty
//     const existingRequest = team.supervisionRequests?.find(
//       req => req.facultyId.toString() === facultyId && req.status === 'pending'
//     );

//     if (existingRequest) {
//       return res.status(400).json({ 
//         message: `Your team has already sent a supervision request to ${faculty.name}`,
//         action: 'duplicate_request'
//       });
//     }

//     // Check if team already has an accepted supervisor
//     if (team.currentSupervisor && team.currentSupervisor.facultyId) {
//       return res.status(400).json({
//         message: `Your team already has a supervisor: ${team.currentSupervisor.facultyName}`,
//         action: 'already_supervised'
//       });
//     }

//     // Initialize supervisionRequests array if it doesn't exist
//     if (!team.supervisionRequests) {
//       team.supervisionRequests = [];
//     }

//     // Add supervision request to team
//     const supervisionRequest = {
//       facultyId: faculty._id,
//       facultyName: faculty.name,
//       facultyDepartment: faculty.department,
//       facultyEmail: faculty.email,
//       requestedBy: student._id,
//       requestedByName: student.name,
//       status: 'pending',
//       requestDate: new Date(),
//       message: message
//     };

//     team.supervisionRequests.push(supervisionRequest);
    
//     // ✅ IMPORTANT: Mark the field as modified for proper saving
//     team.markModified('supervisionRequests');
//     await team.save();

//     // Create the original SupervisionRequest for faculty dashboard
//     const originalSupervisionRequest = new SupervisionRequest({
//       teamId: team._id,
//       facultyId: faculty._id,
//       requesterId: req.user.id,
//       teamName: team.name,
//       facultyName: faculty.name,
//       requesterName: student.name,
//       message: message
//     });

//     await originalSupervisionRequest.save();

//     // ✅ NEW: Create notifications for ALL team members
//     const teamMemberIds = [];
//     for (const member of team.members) {
//       const memberStudent = await Student.findOne({ studentId: member.studentId });
//       if (memberStudent && memberStudent._id.toString() !== student._id.toString()) {
//         teamMemberIds.push(memberStudent._id);
//       }
//     }

//     // Send notifications to all team members
//     for (const memberId of teamMemberIds) {
//       const notification = new Notification({
//         recipientId: memberId,
//         type: 'general',
//         title: 'Supervision Request Sent',
//         message: `Team leader ${student.name} sent a supervision request to ${faculty.name}`,
//         data: {
//           teamId: team._id,
//           teamName: team.name,
//           facultyName: faculty.name,
//           requestId: originalSupervisionRequest._id
//         },
//         read: false
//       });
//       await notification.save();
//     }

//     console.log(`✅ Supervision request sent to ${faculty.name} by ${student.name} for team ${team.name}`);

//     res.json({
//       success: true,
//       message: `Supervision request sent to ${faculty.name} successfully`,
//       requestId: originalSupervisionRequest._id
//     });

//   } catch (error) {
//     console.error('Supervision request error:', error);
//     res.status(500).json({ message: 'Server error while sending supervision request' });
//   }
// });


// Add endpoint to get team's supervision requests
app.get('/api/supervision/my-requests', authenticate, async (req, res) => {
  try {
    const student = await Student.findById(req.user.id);
    if (!student) {
      return res.status(404).json({ message: 'Student not found' });
    }

    const team = await Team.findOne({
      'members.studentId': student.studentId
    });

    if (!team) {
      return res.status(404).json({ message: 'You are not in a team' });
    }

    const requests = await SupervisionRequest.find({
      teamId: team._id
    })
    .populate('facultyId', 'name email department')
    .sort({ requestDate: -1 });

    res.json({
      success: true,
      requests: requests
    });

  } catch (error) {
    console.error('Get supervision requests error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Add this endpoint to handle supervision requests
// Replace the existing supervision request endpoint with this enhanced version
app.post('/api/supervision/request', authenticate, async (req, res) => {
  try {
    const { facultyId, message } = req.body;
    
    if (!facultyId || !message) {
      return res.status(400).json({ message: 'Faculty ID and message are required' });
    }

    const student = await Student.findById(req.user.id);
    if (!student) {
      return res.status(404).json({ message: 'Student not found' });
    }

    // Check if student is in a team
    const team = await Team.findOne({
      'members.studentId': student.studentId
    });

    if (!team) {
      return res.status(403).json({ message: 'You must be in a team to request supervision' });
    }

    // ✅ NEW: Check if user is team leader
    const teamMember = team.members.find(member => member.studentId === student.studentId);
    if (!teamMember || teamMember.role !== 'Leader') {
      return res.status(403).json({ message: 'Only team leaders can send supervision requests' });
    }

    // Check if faculty exists and is visible to students
    const faculty = await Faculty.findById(facultyId);
    if (!faculty) {
      return res.status(404).json({ message: 'Faculty not found' });
    }

    if (!faculty.visibleToStudents) {
      return res.status(403).json({ message: 'This faculty is not available for supervision requests' });
    }

    // ✅ NEW: Check if already sent request to this faculty
    const existingRequest = team.supervisionRequests.find(
      req => req.facultyId.toString() === facultyId && req.status === 'pending'
    );

    if (existingRequest) {
      return res.status(400).json({ 
        message: `Your team has already sent a supervision request to ${faculty.name}`,
        action: 'duplicate_request'
      });
    }

    // Check if team already has an accepted supervisor
    if (team.currentSupervisor && team.currentSupervisor.facultyId) {
      return res.status(400).json({
        message: `Your team already has a supervisor: ${team.currentSupervisor.facultyName}`,
        action: 'already_supervised'
      });
    }

    // ✅ NEW: Add supervision request to team
    const supervisionRequest = {
      facultyId: faculty._id,
      facultyName: faculty.name,
      facultyDepartment: faculty.department,
      facultyEmail: faculty.email,
      requestedBy: student._id,
      requestedByName: student.name,
      status: 'pending',
      requestDate: new Date(),
      message: message
    };

    team.supervisionRequests.push(supervisionRequest);
    await team.save();

    // Create the original SupervisionRequest for faculty dashboard
    const originalSupervisionRequest = new SupervisionRequest({
      teamId: team._id,
      facultyId: faculty._id,
      requesterId: req.user.id,
      teamName: team.name,
      facultyName: faculty.name,
      requesterName: student.name,
      message: message
    });

    await originalSupervisionRequest.save();

    // Create notification for faculty
    await createNotification(
      facultyId,
      'Faculty',
      'supervision_request',
      'New Supervision Request',
      `Team "${team.name}" has requested your supervision for their CSE 400 project`,
      {
        teamId: team._id.toString(),
        teamName: team.name,
        requestId: originalSupervisionRequest._id.toString(),
        senderName: student.name,
        senderStudentId: student.studentId
      }
    );


    res.json({
      success: true,
      message: `Supervision request sent to ${faculty.name} successfully`,
      requestId: originalSupervisionRequest._id
    });

  } catch (error) {
    console.error('Supervision request error:', error);
    res.status(500).json({ message: 'Server error while sending supervision request' });
  }
});


// Add this new endpoint to handle faculty responses
app.put('/api/faculty/supervision-requests/:requestId/respond', authenticate, async (req, res) => {
  try {
    const { requestId } = req.params;
    const { status } = req.body;
    
    if (req.user.role !== 'faculty') {
      return res.status(403).json({ message: 'Access denied: Faculty only' });
    }

    if (!['accepted', 'rejected'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    const supervisionRequest = await SupervisionRequest.findOneAndUpdate(
      { _id: requestId, facultyId: req.user.id },
      { 
        status: status, 
        responseDate: new Date() 
      },
      { new: true }
    ).populate('teamId', 'name members major semester projectIdea');

    if (!supervisionRequest) {
      return res.status(404).json({ message: 'Supervision request not found' });
    }

    // Update team's supervision request status
    const team = await Team.findById(supervisionRequest.teamId);
    if (team) {
      const teamRequestIndex = team.supervisionRequests.findIndex(
      request => request.facultyId.toString() === req.user.id  // ✅ FIXED: renamed 'req' to 'request'
        );
      
      if (teamRequestIndex !== -1) {
        team.supervisionRequests[teamRequestIndex].status = status;
        team.supervisionRequests[teamRequestIndex].responseDate = new Date();
        
        // If accepted, set as current supervisor and update team
        if (status === 'accepted') {
          const faculty = await Faculty.findById(req.user.id);
          team.currentSupervisor = {
            facultyId: faculty._id,
            facultyName: faculty.name,
            facultyDepartment: faculty.department,
            acceptedDate: new Date()
          };
          
          // Add supervisor field for easier queries
          team.supervisor = faculty._id;
          
          // Mark other pending requests as rejected
      team.supervisionRequests.forEach((request, index) => {  // ✅ ALSO FIXED: renamed 'request' parameter
            if (index !== teamRequestIndex && request.status === 'pending') {
              request.status = 'rejected';
              request.responseDate = new Date();
            }
          });

          // Notify all team members about supervision acceptance
          const teamMemberStudents = await Student.find({
            studentId: { $in: team.members.map(m => m.studentId) }
          });

          for (const student of teamMemberStudents) {
            const notification = new Notification({
              recipientId: student._id,
              recipientType: 'Student',
              type: 'general',
              title: 'Supervision Request Accepted!',
              message: `🎉 ${faculty.name} has accepted to supervise your team "${team.name}"!`,
              data: {
                teamId: team._id,
                teamName: team.name,
                supervisorName: faculty.name,
                supervisorDepartment: faculty.department
              },
              read: false
            });
            await notification.save();
          }
        }
        
        await team.save();
      }
    }

    res.json({
      success: true,
      message: `Supervision request ${status} successfully`,
      request: supervisionRequest,
      team: status === 'accepted' ? team : null
    });

  } catch (error) {
    console.error('Supervision response error:', error);
    res.status(500).json({ message: 'Server error while responding to supervision request' });
  }
});


// Get supervised teams for faculty
app.get('/api/faculty/supervised-teams', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'faculty') {
      return res.status(403).json({ message: 'Access denied: Faculty only' });
    }

    const supervisedTeams = await Team.find({
      supervisor: req.user.id,
      'currentSupervisor.facultyId': req.user.id
    }).lean();

    // Get detailed student information for each team
    const teamsWithDetails = await Promise.all(
      supervisedTeams.map(async (team) => {
        const memberStudentIds = team.members.map(member => member.studentId);
        const studentsWithDetails = await Student.find({
          studentId: { $in: memberStudentIds }
        }).select('studentId name email program completedCredits cgpa avatar phone');

        const studentDetailsMap = new Map(
          studentsWithDetails.map(student => [student.studentId, student])
        );

        const enhancedMembers = team.members.map(member => {
          const studentDetails = studentDetailsMap.get(member.studentId);
          return {
            ...member,
            email: studentDetails?.email || 'Not available',
            program: studentDetails?.program || 'Not specified',
            completedCredits: studentDetails?.completedCredits || 0,
            cgpa: studentDetails?.cgpa || 0.0,
            avatar: studentDetails?.avatar || null,
            phone: studentDetails?.phone || 'Not available'
          };
        });

        // Calculate team statistics
        const validCGPAs = enhancedMembers.filter(m => m.cgpa > 0).map(m => m.cgpa);
        const averageCGPA = validCGPAs.length > 0 ? 
          validCGPAs.reduce((sum, cgpa) => sum + cgpa, 0) / validCGPAs.length : 0;


          const currentPhaseStartDate = team.currentPhaseStartDate || team.createdDate || new Date();
        const currentPhaseDuration = Math.floor((new Date() - currentPhaseStartDate) / (1000 * 60 * 60 * 24));
        
        // Get phase history with formatted dates
        const formattedPhaseHistory = (team.phaseHistory || []).map(phase => ({
          ...phase,
          startDate: phase.startDate,
          endDate: phase.endDate,
          duration: phase.duration || 0,
          formattedDuration: phase.duration ? `${phase.duration} days` : 'Ongoing'
        }));


        return {
          ...team,
          members: enhancedMembers,
          averageCGPA: averageCGPA.toFixed(2),
          totalCompletedCredits: enhancedMembers.reduce((sum, member) => sum + (member.completedCredits || 0), 0),
          isVisible: team.status !== 'hidden', // For join page visibility
          canReceiveRequests: team.status === 'recruiting' || team.status === 'active',
          currentPhaseStartDate: currentPhaseStartDate,
          currentPhaseDuration: currentPhaseDuration,
          phaseHistory: formattedPhaseHistory,
          phaseUpdatedAt: team.phaseUpdatedAt
        };
      })
    );

    res.json({
      success: true,
      teams: teamsWithDetails,
      totalTeams: teamsWithDetails.length
    });

  } catch (error) {
    console.error('Get supervised teams error:', error);
    res.status(500).json({ message: 'Server error while fetching supervised teams' });
  }
});

// Update team visibility (hide/show in join page)
app.put('/api/faculty/teams/:teamId/visibility', authenticate, async (req, res) => {
  try {
    const { teamId } = req.params;
    const { visible } = req.body;

    if (req.user.role !== 'faculty') {
      return res.status(403).json({ message: 'Access denied: Faculty only' });
    }

    const team = await Team.findOne({
      _id: teamId,
      supervisor: req.user.id
    });

    if (!team) {
      return res.status(404).json({ message: 'Team not found or you are not the supervisor' });
    }

    // Update team status based on visibility
    const newStatus = visible ? (team.members.length >= 4 ? 'active' : 'recruiting') : 'hidden';
    
    team.status = newStatus;
    team.visibleInJoinPage = visible;
    team.lastStatusUpdate = new Date();

    await team.save();

    // Notify team members about visibility change
    const teamMemberStudents = await Student.find({
      studentId: { $in: team.members.map(m => m.studentId) }
    });

    const faculty = await Faculty.findById(req.user.id);

    for (const student of teamMemberStudents) {
      const notification = new Notification({
        recipientId: student._id,
        recipientType: 'Student',
        type: 'general',
        title: 'Team Visibility Updated',
        message: `Your supervisor ${faculty.name} has ${visible ? 'enabled' : 'disabled'} your team "${team.name}" from receiving new join requests.`,
        data: {
          teamId: team._id,
          teamName: team.name,
          supervisorName: faculty.name,
          visible: visible,
          action: 'visibility_update'
        },
        read: false
      });
      await notification.save();
    }

    res.json({
      success: true,
      message: `Team visibility ${visible ? 'enabled' : 'disabled'} successfully`,
      team: {
        id: team._id,
        name: team.name,
        status: team.status,
        visible: visible,
        canReceiveRequests: newStatus !== 'hidden'
      }
    });

  } catch (error) {
    console.error('Update team visibility error:', error);
    res.status(500).json({ message: 'Server error while updating team visibility' });
  }
});


// Update team status by supervisor
app.put('/api/faculty/teams/:teamId/status', authenticate, async (req, res) => {
  try {
    const { teamId } = req.params;
    const { status, reason } = req.body;

    if (req.user.role !== 'faculty') {
      return res.status(403).json({ message: 'Access denied: Faculty only' });
    }

    const validStatuses = ['active', 'recruiting', 'inactive', 'hidden', 'completed'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

const team = await Team.findById(teamId);
if (!team) {
  return res.status(404).json({ message: 'Team not found' });
}

// ✅ Check if faculty is the actual supervisor
if (!team.currentSupervisor || team.currentSupervisor.facultyId.toString() !== req.user.id) {
  return res.status(403).json({ message: 'You are not the supervisor of this team' });
}

    const previousStatus = team.status;
    team.status = status;
    team.lastStatusUpdate = new Date();
    team.statusReason = reason || '';

    await team.save();

    // Notify team members about status change
    const teamMemberStudents = await Student.find({
      studentId: { $in: team.members.map(m => m.studentId) }
    });

    const faculty = await Faculty.findById(req.user.id);
    const statusMessages = {
      'active': 'activated and ready for project work',
      'recruiting': 'set to recruiting mode',
      'inactive': 'temporarily deactivated',
      'hidden': 'hidden from join requests',
      'completed': 'marked as completed'
    };

    for (const student of teamMemberStudents) {
      const notification = new Notification({
        recipientId: student._id,
        recipientType: 'Student',
        type: 'general',
        title: 'Team Status Updated',
        message: `Your supervisor ${faculty.name} has ${statusMessages[status]} your team "${team.name}".${reason ? ` Reason: ${reason}` : ''}`,
        data: {
          teamId: team._id,
          teamName: team.name,
          supervisorName: faculty.name,
          previousStatus: previousStatus,
          newStatus: status,
          reason: reason,
          action: 'status_update'
        },
        read: false
      });
      await notification.save();
    }

    res.json({
      success: true,
      message: `Team status updated to ${status} successfully`,
      team: {
        id: team._id,
        name: team.name,
        previousStatus: previousStatus,
        newStatus: status,
        reason: reason
      }
    });

  } catch (error) {
    console.error('Update team status error:', error);
    res.status(500).json({ message: 'Server error while updating team status' });
  }
});


// Get sent supervision requests for a student
app.get('/api/supervision/my-requests', authenticate, async (req, res) => {
  try {
    const requests = await SupervisionRequest.find({
      studentId: req.user.id
    }).populate('facultyId', 'name email');

    const sentFacultyIds = requests.map(req => req.facultyId._id);
    
    res.json({ 
      success: true, 
      sentRequests: sentFacultyIds,
      requests 
    });
  } catch (error) {
    console.error('Get supervision requests error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Add this endpoint in server.js after your existing supervision request endpoints

// Get detailed team information for faculty (when viewing supervision requests)
// Enhanced supervision requests endpoint for faculty - FIXED VERSION
app.get('/api/faculty/team-details/:teamId', authenticate, async (req, res) => {
  try {
    const { teamId } = req.params;
    
    // Verify the requester is faculty
    if (req.user.role !== 'faculty') {
      return res.status(403).json({ 
        success: false, 
        message: 'Access denied: Faculty only' 
      });
    }

    console.log('Faculty requesting team details for teamId:', teamId); // Debug log

    // Validate teamId format
    if (!mongoose.Types.ObjectId.isValid(teamId)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid team ID format' 
      });
    }

    // Get team details with populated member information
    const team = await Team.findById(teamId).lean();
    
    if (!team) {
      return res.status(404).json({ 
        success: false, 
        message: 'Team not found' 
      });
    }

    // Get detailed student information for each team member
    const memberStudentIds = team.members.map(member => member.studentId);
    const studentsWithDetails = await Student.find({
      studentId: { $in: memberStudentIds }
    }).select('studentId name email program completedCredits cgpa avatar phone address enrolled');

    // Create a map for easy lookup
    const studentDetailsMap = new Map(
      studentsWithDetails.map(student => [student.studentId, student])
    );

    // Enhance team members with full student details
    const enhancedMembers = team.members.map(member => {
      const studentDetails = studentDetailsMap.get(member.studentId);
      return {
        ...member,
        email: studentDetails?.email || 'Not available',
        program: studentDetails?.program || 'Not specified',
        completedCredits: studentDetails?.completedCredits || 0,
        cgpa: studentDetails?.cgpa || 0.0,
        avatar: studentDetails?.avatar || null,
        phone: studentDetails?.phone || 'Not available',
        address: studentDetails?.address || 'Not specified',
        enrolled: studentDetails?.enrolled || 'Not specified',
        joinedDate: member.joinedDate || team.createdDate
      };
    });

    // Calculate team statistics
    const validCGPAs = enhancedMembers.filter(m => m.cgpa > 0).map(m => m.cgpa);
    const averageCGPA = validCGPAs.length > 0 ? 
      validCGPAs.reduce((sum, cgpa) => sum + cgpa, 0) / validCGPAs.length : 0;

    const totalCompletedCredits = enhancedMembers.reduce((sum, member) => 
      sum + (member.completedCredits || 0), 0);

    // Return enhanced team information with success flag
    const teamWithDetails = {
      ...team,
      members: enhancedMembers,
      memberCount: enhancedMembers.length,
      averageCGPA: averageCGPA,
      totalCompletedCredits: totalCompletedCredits,
      createdDate: team.createdDate || new Date()
    };

    console.log('Returning team details for:', team.name); // Debug log

    res.json({
      success: true,
      team: teamWithDetails,
      message: 'Team details retrieved successfully'
    });

  } catch (error) {
    console.error('Get team details error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Server error while fetching team details',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});


// Enhanced supervision requests endpoint for faculty
app.get('/api/faculty/supervision-requests', authenticate, async (req, res) => {
  try {
    // Verify the requester is faculty
    if (req.user.role !== 'faculty') {
      return res.status(403).json({ message: 'Access denied: Faculty only' });
    }

    const supervisionRequests = await SupervisionRequest.find({
      facultyId: req.user.id
    })
    .populate('teamId', 'name major semester projectIdea description memberCount members')
    .populate('requesterId', 'name studentId email')
    .sort({ requestDate: -1 });

    // Format the response with team preview information
    const formattedRequests = supervisionRequests.map(request => ({
      _id: request._id,
      teamId: request.teamId._id,
      teamName: request.teamId.name,
      teamMajor: request.teamId.major,
      teamSemester: request.teamId.semester,
      projectIdea: request.teamId.projectIdea,
      memberCount: request.teamId.memberCount,
      requesterName: request.requesterName,
      requesterStudentId: request.requesterId.studentId,
      message: request.message,
      status: request.status,
      requestDate: request.requestDate,
      responseDate: request.responseDate
    }));

    res.json({
      success: true,
      requests: formattedRequests
    });

  } catch (error) {
    console.error('Get supervision requests error:', error);
    res.status(500).json({ message: 'Server error while fetching supervision requests' });
  }
});

// Add this endpoint in server.js
app.put('/api/faculty/supervision-requests/:requestId/respond', authenticate, async (req, res) => {
  try {
    const { requestId } = req.params;
    const { status } = req.body;
    
    if (req.user.role !== 'faculty') {
      return res.status(403).json({ message: 'Access denied: Faculty only' });
    }

    if (!['accepted', 'rejected'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    const supervisionRequest = await SupervisionRequest.findOneAndUpdate(
      { _id: requestId, facultyId: req.user.id },
      { 
        status: status, 
        responseDate: new Date() 
      },
      { new: true }
    ).populate('teamId', 'name');

    if (!supervisionRequest) {
      return res.status(404).json({ message: 'Supervision request not found' });
    }

    // If accepted, update the team's supervisor
    if (status === 'accepted') {
      await Team.findByIdAndUpdate(supervisionRequest.teamId, {
        supervisor: req.user.id
      });
    }

    res.json({
      success: true,
      message: `Supervision request ${status} successfully`,
      request: supervisionRequest
    });

  } catch (error) {
    console.error('Supervision response error:', error);
    res.status(500).json({ message: 'Server error while responding to supervision request' });
  }
});


// In your server.js file around line 4498-4500
app.get('/api/faculty/supervision-requests', authenticate, async (req, res) => {
  try {
    const facultyId = req.user.id;
    
    const supervisionRequests = await SupervisionRequest.find({
      facultyId: facultyId,
      status: { $in: ['pending', 'accepted', 'rejected'] }
    })
    .populate('teamId')
    .populate('requesterId')
    .sort({ requestDate: -1 });

    // Filter out null values and add null checks
    const validRequests = supervisionRequests
      .filter(request => request && request.teamId && request.requesterId) // Filter out null references
      .map(request => ({
        _id: request._id,
        teamId: request.teamId?._id,
        teamName: request.teamId?.name || 'Unknown Team',
        teamMajor: request.teamId?.major || 'Unknown Major',
        teamSemester: request.teamId?.semester || 'Unknown Semester',
        memberCount: request.teamId?.members?.length || 0,
        projectIdea: request.teamId?.projectIdea || 'No project description',
        requesterName: request.requesterId?.name || 'Unknown Student',
        requesterStudentId: request.requesterId?.studentId || 'Unknown ID',
        message: request.message || '',
        status: request.status,
        requestDate: request.requestDate
      }));

    res.json({ 
      success: true, 
      requests: validRequests 
    });

  } catch (error) {
    console.error('Get supervision requests error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch supervision requests' 
    });
  }
});

// In your server.js file
const cleanupOrphanedSupervisionRequests = async () => {
  try {
    console.log('Starting cleanup of orphaned supervision requests...');
    const requests = await SupervisionRequest.find({});
    let deletedCount = 0;
    
    for (let request of requests) {
      let shouldDelete = false;
      
      // Check if team exists
      if (request.teamId) {
        const team = await Team.findById(request.teamId);
        if (!team) {
          console.log(`Deleting request with invalid teamId: ${request.teamId}`);
          shouldDelete = true;
        }
      }
      
      // Check if requester exists
      if (request.requesterId) {
        const requester = await Student.findById(request.requesterId);
        if (!requester) {
          console.log(`Deleting request with invalid requesterId: ${request.requesterId}`);
          shouldDelete = true;
        }
      }
      
      if (shouldDelete) {
        await SupervisionRequest.findByIdAndDelete(request._id);
        deletedCount++;
      }
    }
    
    console.log(`Cleanup completed. Deleted ${deletedCount} orphaned requests.`);
    return { success: true, deletedCount };
  } catch (error) {
    console.error('Cleanup error:', error);
    return { success: false, error: error.message };
  }
};

// Add an endpoint to trigger cleanup manually
app.post('/api/admin/cleanup-supervision-requests', authenticate, async (req, res) => {
  try {
    // Only allow admin users to run cleanup
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }
    
    const result = await cleanupOrphanedSupervisionRequests();
    res.json(result);
  } catch (error) {
    console.error('Cleanup endpoint error:', error);
    res.status(500).json({ message: 'Cleanup failed' });
  }
});

// NEW: Send team member request (for existing team members)
// NEW: Send team member request (for existing team members) - ENHANCED
app.post('/api/teams/member-request', authenticate, async (req, res) => {
  try {
    const {
      targetStudentId,
      targetStudentName,
      targetStudentEmail,
      message
    } = req.body;

    const sender = await Student.findById(req.user.id).select('name studentId email program skills');    if (!sender) {
      return res.status(404).json({ message: 'Sender not found' });
    }

    // Check if sender is in a team
    const senderTeam = await Team.findOne({
      'members.studentId': sender.studentId
    });

    if (!senderTeam) {
      return res.status(403).json({ message: 'You must be in a team to send member requests' });
    }

    // Check if target student exists and is not in a team
    const targetStudent = await Student.findById(targetStudentId);
    if (!targetStudent) {
      return res.status(404).json({ message: 'Target student not found' });
    }

    const targetExistingTeam = await Team.findOne({
      'members.studentId': targetStudent.studentId
    });
    if (targetExistingTeam) {
      return res.status(400).json({ 
        message: `${targetStudent.name} is already in team "${targetExistingTeam.name}"` 
      });
    }

    // ✅ ENHANCED: Check for duplicate requests from ANY team member
    const existingTeamRequest = await TeamRequest.findOne({
      teamId: senderTeam._id,
      targetStudentId: targetStudentId,
      status: { $in: ['pending', 'awaiting_leader'] }
    });

    if (existingTeamRequest) {
      const originalSender = await Student.findById(existingTeamRequest.senderId);
      return res.status(400).json({ 
        message: `Your team has already sent a request to ${targetStudent.name} by ${originalSender?.name || 'another member'}`,
        action: 'duplicate_team_request'
      });
    }

    // Check if team is full
    if (senderTeam.members.length >= 4) {
      return res.status(400).json({ 
        message: 'Your team is already full (4/4 members)' 
      });
    }

    // Determine if leader approval is needed
    const isLeader = senderTeam.members.find(m => 
      m.studentId === sender.studentId && m.role === 'Leader'
    );
    const requiresLeaderApproval = !isLeader;

    // Create team member request
    const teamRequest = new TeamRequest({
      teamName: senderTeam.name,
      teamId: senderTeam._id,
      teamData: {
        name: senderTeam.name,
        major: senderTeam.major,
        semester: senderTeam.semester,
        projectIdea: senderTeam.projectIdea,
        capstone: senderTeam.capstone || 'CSE 400',
        description: senderTeam.description
      },
      senderStudentId: sender.studentId,
      senderName: sender.name,
      senderEmail: sender.email,
      senderSkills: sender.skills || [],
      senderId: req.user.id,
      targetStudentId: targetStudentId,
      targetStudentEmail: targetStudentEmail,
      targetStudentName: targetStudentName,
      message: message || `${sender.name} from team "${senderTeam.name}" has invited you to join their team`,
      requestType: 'join_existing',
      requiresLeaderApproval: requiresLeaderApproval,
      status: 'pending'
    });

    await teamRequest.save();

    // Create notification for target student
    await createTeamRequestNotification({
      recipientId: targetStudentId,
      senderName: sender.name,
      senderStudentId: sender.studentId,
      teamName: senderTeam.name,
      requestId: teamRequest._id,
      message: requiresLeaderApproval 
        ? `${sender.name} from team "${senderTeam.name}" invited you to join their team.`
        : `${sender.name} from team "${senderTeam.name}" invited you to join their team.`
    });

    // ✅ Send email to target student
    try {
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: "capstoneserverewu@gmail.com",
          pass: "ppry snhj xcuc zfdc",
        },
      });

      const mailOptions = {
        from: '"Supervise Me" <capstoneserverewu@gmail.com>',
        to: targetStudent.email,
        subject: `Team Invitation: Join "${senderTeam.name}"`,
        html: `
          <p>Hi ${targetStudent.name},</p>
          <p><strong>${sender.name}</strong> from team "<strong>${senderTeam.name}</strong>" has invited you to join their CSE 400 team.</p>
          
          <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px; margin: 15px 0;">
            <h4>Team Details:</h4>
            <p><strong>Team:</strong> ${senderTeam.name}</p>
            <p><strong>Major:</strong> ${senderTeam.major}</p>
            <p><strong>Current Members:</strong> ${senderTeam.members.length}/4</p>
            <p><strong>Invited by:</strong> ${sender.name}</p>
            ${senderTeam.projectIdea ? `<p><strong>Project:</strong> ${senderTeam.projectIdea}</p>` : ''}
          </div>
          
          <p>Login to the Capstone Portal to accept or decline:</p>
          <p><a href="${process.env.REACT_APP_CLIENT_URL || 'http://localhost:3000'}" target="_blank">Go to Portal</a></p>
          <hr/>
          <p>This is an automated email from the EWU Capstone System.</p>
        `,
      };

      await transporter.sendMail(mailOptions);
      console.log(`📧 Team invitation email sent to ${targetStudent.email}`);
    } catch (emailErr) {
      console.error('❌ Team invitation email failed:', emailErr);
    }

    res.json({
      success: true,
      message: requiresLeaderApproval 
        ? `Invitation sent to ${targetStudent.name}! If accepted, it will need leader approval.`
        : `Invitation sent to ${targetStudent.name} successfully!`,
      requestId: teamRequest._id,
      requiresLeaderApproval: requiresLeaderApproval
    });

  } catch (error) {
    console.error('Team member request error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});


// NEW: Handle leader approval for team member requests - ENHANCED
app.post('/api/teams/approve-member-request', authenticate, async (req, res) => {
  try {
    const { requestId, action } = req.body; // action: 'approve' or 'reject'

    const request = await TeamRequest.findById(requestId)
      .populate('targetStudentId', 'name studentId email')
      .populate('senderId', 'name studentId');
      
    if (!request) {
      return res.status(404).json({ message: 'Request not found' });
    }

    const student = await Student.findById(req.user.id);
    const team = await Team.findById(request.teamId);

    if (!team) {
      return res.status(404).json({ message: 'Team not found' });
    }

    // Check if user is team leader
    const leader = team.members.find(member => member.role === 'Leader');
    if (!leader || leader.studentId !== student.studentId) {
      return res.status(403).json({ message: 'Only team leaders can approve member requests' });
    }

    const targetStudent = request.targetStudentId;

    if (action === 'approve') {
      // Check if target is still available
      const targetTeam = await Team.findOne({
        'members.studentId': targetStudent.studentId
      });
      if (targetTeam) {
        request.status = 'rejected';
        request.leaderApprovalStatus = 'rejected';
        request.leaderResponseDate = new Date();
        await request.save();

        return res.status(400).json({ 
          message: `${targetStudent.name} has already joined another team` 
        });
      }

      // Check team capacity
      if (team.members.length >= 4) {
        request.status = 'rejected';
        request.leaderApprovalStatus = 'rejected';
        request.leaderResponseDate = new Date();
        await request.save();

        return res.status(400).json({ 
          message: 'Team is already full (4/4 members)' 
        });
      }

      // Add member to team
      team.members.push({
        studentId: targetStudent.studentId,
        name: targetStudent.name,
        email: targetStudent.email,
        program: targetStudent.program || 'Computer Science',
        role: 'Member',
        joinedDate: new Date()
      });

      team.memberCount = team.members.length;
      if (team.members.length >= 4) {
        team.status = 'active';
      }

      await team.save();

      // Update request status
      request.status = 'accepted';
      request.leaderApprovalStatus = 'approved';
      request.leaderResponseDate = new Date();
      await request.save();

      // ✅ Create notification for target student
      const notification = new Notification({
        recipientId: request.targetStudentId._id,
        type: 'team_accepted',
        title: 'Team Request Approved!',
        message: `Your request to join team "${team.name}" has been approved by team leader ${student.name}!`,
        data: {
          teamId: team._id,
          teamName: team.name,
          approvedBy: student.name,
          invitedBy: request.senderName
        },
        read: false
      });
      await notification.save();

      // ✅ Send approval email
      try {
        const transporter = nodemailer.createTransport({
          service: 'gmail',
          auth: {
            user: "capstoneserverewu@gmail.com",
            pass: "ppry snhj xcuc zfdc",
          },
        });

        const mailOptions = {
          from: '"Supervise Me" <capstoneserverewu@gmail.com>',
          to: targetStudent.email,
          subject: `✅ Team Request Approved - Welcome to "${team.name}"!`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
              <h2 style="color: #10b981;">🎉 Request Approved!</h2>
              <p>Hi ${targetStudent.name},</p>
              <p>Great news! Your request to join team "<strong>${team.name}</strong>" has been <strong>approved</strong> by team leader <strong>${student.name}</strong>.</p>
              
              <div style="background-color: #f0fdf4; padding: 15px; border-radius: 5px; margin: 15px 0;">
                <h4>Team Details:</h4>
                <p><strong>Team:</strong> ${team.name}</p>
                <p><strong>Leader:</strong> ${student.name}</p>
                <p><strong>Current Members:</strong> ${team.members.length}/4</p>
                <p><strong>Originally Invited By:</strong> ${request.senderName}</p>
                <p><strong>Major:</strong> ${team.major}</p>
                ${team.projectIdea ? `<p><strong>Project:</strong> ${team.projectIdea}</p>` : ''}
              </div>
              
              <p>You can now access your team chat and collaborate on your CSE 400 project!</p>
              <p><a href="${process.env.REACT_APP_CLIENT_URL || 'http://localhost:3000'}" style="background-color: #3b82f6; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px;">Go to Team Dashboard</a></p>
              <hr/>
              <p>This is an automated email from the EWU Capstone System.</p>
            </div>
          `,
        };

        await transporter.sendMail(mailOptions);
      } catch (emailErr) {
        console.error('❌ Approval email failed:', emailErr);
      }

      res.json({
        success: true,
        message: `${targetStudent.name} has been added to the team`,
        team: team
      });

    } else if (action === 'reject') {
      request.status = 'rejected';
      request.leaderApprovalStatus = 'rejected';
      request.leaderResponseDate = new Date();
      await request.save();

      // Create notification for target student
      const notification = new Notification({
        recipientId: request.targetStudentId._id,
        type: 'team_rejected',
        title: 'Team Request Declined',
        message: `Your request to join team "${team.name}" was declined by team leader ${student.name}.`,
        data: {
          teamId: team._id,
          teamName: team.name,
          rejectedBy: student.name,
          invitedBy: request.senderName
        },
        read: false
      });
      await notification.save();

      // ✅ Send rejection email
      try {
        const transporter = nodemailer.createTransport({
          service: 'gmail',
          auth: {
            user: "capstoneserverewu@gmail.com",
            pass: "ppry snhj xcuc zfdc",
          },
        });

        const mailOptions = {
          from: '"Supervise Me" <capstoneserverewu@gmail.com>',
          to: targetStudent.email,
          subject: `Team Request Declined - "${team.name}"`,
          html: `
            <p>Hi ${targetStudent.name},</p>
            <p>Your request to join team "<strong>${team.name}</strong>" was declined by team leader <strong>${student.name}</strong>.</p>
            <p>You can continue to browse other available teams or create your own.</p>
            <p><a href="${process.env.REACT_APP_CLIENT_URL || 'http://localhost:3000'}" target="_blank">Back to Portal</a></p>
            <hr/>
            <p>This is an automated email from the EWU Capstone System.</p>
          `,
        };

        await transporter.sendMail(mailOptions);
      } catch (emailErr) {
        console.error('❌ Rejection email failed:', emailErr);
      }

      res.json({
        success: true,
        message: 'Member request rejected'
      });
    } else {
      return res.status(400).json({ message: 'Invalid action' });
    }

  } catch (error) {
    console.error('Approve member request error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});


// NEW: Get pending leader approvals for team leader
app.get('/api/teams/pending-leader-approvals', authenticate, async (req, res) => {
  try {
    const student = await Student.findById(req.user.id);
    if (!student) {
      return res.status(404).json({ message: 'Student not found' });
    }

    const team = await Team.findOne({
      'members.studentId': student.studentId
    });

    if (!team) {
      return res.status(404).json({ message: 'You are not in a team' });
    }

    // Check if user is team leader
    const leader = team.members.find(member => member.role === 'Leader');
    if (!leader || leader.studentId !== student.studentId) {
      return res.status(403).json({ message: 'Only team leaders can view pending approvals' });
    }

    // Get pending leader approvals
    const pendingApprovals = await TeamRequest.find({
      teamId: team._id,
      status: 'awaiting_leader',
      leaderApprovalStatus: 'pending'
    })
    .populate('targetStudentId', 'name studentId email program completedCredits')
    .populate('senderId', 'name studentId')
    .sort({ sentDate: -1 });

    res.json({
      success: true,
      pendingApprovals: pendingApprovals,
      team: {
        id: team._id,
        name: team.name,
        memberCount: team.members.length
      }
    });

  } catch (error) {
    console.error('Get pending approvals error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});


// Add this endpoint in server.js after your existing team management endpoints

// Admin endpoint to assign supervisor to team
app.post('/api/admin/teams/:teamId/assign-supervisor', authenticate, async (req, res) => {
  try {
    const { teamId } = req.params;
    const { facultyId } = req.body;


    const team = await Team.findById(teamId);
    if (!team) {
      return res.status(404).json({ message: 'Team not found' });
    }

    const faculty = await Faculty.findById(facultyId);
    if (!faculty) {
      return res.status(404).json({ message: 'Faculty not found' });
    }

    // Check if faculty is active and visible to students
    if (faculty.status !== 'Active') {
      return res.status(400).json({ 
        message: `Faculty ${faculty.name} is not active and cannot supervise teams` 
      });
    }

    if (team.currentSupervisor && team.currentSupervisor.facultyId) {
      return res.status(400).json({ 
        message: `Team already has supervisor: ${team.currentSupervisor.facultyName}` 
      });
    }


    const currentMemberCount = team.members?.length || 0;
    const isSpecialCase = currentMemberCount < 4;

    // Update team with supervisor
    team.currentSupervisor = {
      facultyId: faculty._id,
      facultyName: faculty.name,
      facultyDepartment: faculty.department,
      acceptedDate: new Date()
    };

     team.status = 'active';
     team.supervisor = faculty._id;

     if (isSpecialCase) {
      team.specialCase = true;
      team.specialCaseReason = `Supervisor assigned to incomplete team (${currentMemberCount}/4 members)`;
      console.log(`🔒 Team "${team.name}" marked as special case - ${currentMemberCount}/4 members`);
    }

    // Add to supervision requests history if not already there
    const existingRequest = team.supervisionRequests.find(
      req => req.facultyId.toString() === facultyId && req.status === 'accepted'
    );

    if (!existingRequest) {
      team.supervisionRequests.push({
        facultyId: faculty._id,
        facultyName: faculty.name,
        facultyDepartment: faculty.department,
        facultyEmail: faculty.email,
        requestedBy: team.members.find(m => m.role === 'Leader')?._id || team.members[0]?.studentId,
        requestedByName: team.members.find(m => m.role === 'Leader')?.name || team.members?.name || 'Admin',
        status: 'accepted',
        requestDate: new Date(),
        responseDate: new Date(),
        message: 'Assigned by administrator'
      });
    }

    await team.save();

    // Create notifications for all team members
    for (const member of team.members) {
      try {
        const student = await Student.findOne({ studentId: member.studentId });
        if (student) {
          const notification = new Notification({
            recipientId: student._id,
            recipientType: 'Student',
            type: 'general',
            title: 'Supervisor Assigned',
            message: `Administrator has assigned ${faculty.name} as supervisor for your team "${team.name}".`,
            data: {
              teamId: team._id,
              teamName: team.name,
              supervisorName: faculty.name,
              action: 'supervisor_assigned'
            },
            read: false
          });
          await notification.save();
        }
      } catch (notifError) {
        console.error('Error creating notification:', notifError);
      }
    }

    res.json({
      success: true,
      message: `${faculty.name} has been assigned as supervisor to team "${team.name}"`,
      team: team
    });

  } catch (error) {
    console.error('Assign supervisor error:', error);
    res.status(500).json({ message: 'Server error while assigning supervisor' });
  }
});

// Admin endpoint to remove supervisor from team
app.post('/api/admin/teams/:teamId/remove-supervisor', authenticate, async (req, res) => {
  try {
    const { teamId } = req.params;

    const team = await Team.findById(teamId);
    if (!team) {
      return res.status(404).json({ message: 'Team not found' });
    }

    if (!team.currentSupervisor || !team.currentSupervisor.facultyId) {
      return res.status(400).json({ message: 'Team does not have a supervisor assigned' });
    }

    const supervisorName = team.currentSupervisor.facultyName;

    // Remove current supervisor
    team.currentSupervisor = {};

    await team.save();

    // Create notifications for all team members
    for (const member of team.members) {
      try {
        const student = await Student.findOne({ studentId: member.studentId });
        if (student) {
          const notification = new Notification({
            recipientId: student._id,
            recipientType: 'Student',
            type: 'general',
            title: 'Supervisor Removed',
            message: `Administrator has removed ${supervisorName} as supervisor from your team "${team.name}".`,
            data: {
              teamId: team._id,
              teamName: team.name,
              removedSupervisor: supervisorName,
              action: 'supervisor_removed'
            },
            read: false
          });
          await notification.save();
        }
      } catch (notifError) {
        console.error('Error creating notification:', notifError);
      }
    }

    res.json({
      success: true,
      message: `${supervisorName} has been removed as supervisor from team "${team.name}"`,
      team: team
    });

  } catch (error) {
    console.error('Remove supervisor error:', error);
    res.status(500).json({ message: 'Server error while removing supervisor' });
  }
});

// Add this function after your other cleanup functions
const cleanupOrphanedTeamRequests = async () => {
  try {
    console.log('Cleaning up orphaned team requests...');
    
    const requests = await TeamRequest.find({});
    let deletedCount = 0;
    
    for (const request of requests) {
      let shouldDelete = false;
      
      // Check if target student exists
      if (request.targetStudentId) {
        const targetStudent = await Student.findById(request.targetStudentId);
        if (!targetStudent) {
          console.log(`Deleting request with invalid targetStudentId: ${request.targetStudentId}`);
          shouldDelete = true;
        }
      }
      
      // Check if sender exists
      if (request.senderId) {
        const sender = await Student.findById(request.senderId);
        if (!sender) {
          console.log(`Deleting request with invalid senderId: ${request.senderId}`);
          shouldDelete = true;
        }
      }
      
      // Check if team exists (for team member requests)
      if (request.teamId) {
        const team = await Team.findById(request.teamId);
        if (!team) {
          console.log(`Deleting request with invalid teamId: ${request.teamId}`);
          shouldDelete = true;
        }
      }
      
      if (shouldDelete) {
        await TeamRequest.findByIdAndDelete(request._id);
        deletedCount++;
      }
    }
    
    console.log(`✅ Cleanup completed. Deleted ${deletedCount} orphaned team requests.`);
    return deletedCount;
  } catch (error) {
    console.error('❌ Team request cleanup error:', error);
    return 0;
  }
};

// Add cleanup endpoint for admin
app.post('/api/admin/cleanup-team-requests', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }
    
    const deletedCount = await cleanupOrphanedTeamRequests();
    res.json({ 
      success: true, 
      message: `Cleaned up ${deletedCount} orphaned team requests` 
    });
  } catch (error) {
    res.status(500).json({ message: 'Cleanup failed' });
  }
});


// Add cleanup endpoint for admin
app.post('/api/admin/cleanup-team-requests', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }
    
    const deletedCount = await cleanupOrphanedTeamRequests();
    res.json({ 
      success: true, 
      message: `Cleaned up ${deletedCount} orphaned team requests` 
    });
  } catch (error) {
    res.status(500).json({ message: 'Cleanup failed' });
  }
});


// Add this new endpoint after the existing phase update endpoint
app.put('/api/faculty/teams/:teamId/complete-project', authenticate, async (req, res) => {
  try {
    const { teamId } = req.params;

    if (req.user.role !== 'faculty') {
      return res.status(403).json({ message: 'Access denied: Faculty only' });
    }

    const team = await Team.findById(teamId);
    if (!team) {
      return res.status(404).json({ message: 'Team not found' });
    }

    if (!team.currentSupervisor || team.currentSupervisor.facultyId.toString() !== req.user.id) {
      return res.status(403).json({ message: 'You are not the supervisor of this team' });
    }

    // Verify team is in phase C
    const currentPhase = team.currentPhase || team.phase || 'A';
    if (currentPhase !== 'C') {
      return res.status(400).json({ 
        message: 'Project can only be completed when team is in Phase C' 
      });
    }

    const faculty = await Faculty.findById(req.user.id);
    const now = new Date();
    
    // Calculate duration of phase C
    const phaseStartDate = team.currentPhaseStartDate || team.createdDate || new Date();
    const phaseDuration = Math.floor((now - phaseStartDate) / (1000 * 60 * 60 * 24));

    // Update phase history - close phase C with completion
    if (!team.phaseHistory) {
      team.phaseHistory = [];
    }

    // Find and close the current Phase C in history
    const currentPhaseInHistory = team.phaseHistory.find(p => p.phase === 'C' && !p.endDate);
    if (currentPhaseInHistory) {
      currentPhaseInHistory.endDate = now;
      currentPhaseInHistory.duration = phaseDuration;
      currentPhaseInHistory.completed = true; // Mark as completed
    } else {
      // Add Phase C to history if it doesn't exist
      team.phaseHistory.push({
        phase: 'C',
        startDate: phaseStartDate,
        endDate: now,
        duration: phaseDuration,
        completed: true,
        updatedBy: {
          facultyId: faculty._id,
          facultyName: faculty.name
        }
      });
    }

    // Update team status
    team.status = 'completed';
    team.projectCompleted = true;
    team.progressStatus = 'Completed';
    team.projectCompletedDate = now;
    team.phaseUpdatedAt = now;

    await team.save();

    // Create notifications for team members
    const teamMemberStudents = await Student.find({
      studentId: { $in: team.members.map(m => m.studentId) }
    });

    for (const student of teamMemberStudents) {
      const notification = new Notification({
        recipientId: student._id,
        recipientType: 'Student',
        type: 'general',
        title: 'Project Completed!',
        message: `Congratulations! Your supervisor ${faculty.name} has marked your project "${team.name}" as completed.`,
        data: {
          teamId: team._id,
          teamName: team.name,
          supervisorName: faculty.name,
          completionDate: now,
          action: 'project_completed'
        },
        read: false
      });
      await notification.save();
    }

    res.json({
      success: true,
      message: `Project "${team.name}" has been marked as completed successfully!`,
      team: {
        id: team._id,
        name: team.name,
        status: team.status,
        projectCompleted: team.projectCompleted,
        projectCompletedDate: now,
        phaseDuration: phaseDuration
      }
    });

  } catch (error) {
    console.error('Complete project error:', error);
    res.status(500).json({ message: 'Server error while completing project' });
  }
});


app.get('/api/faculty/supervised-teams-progress', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'faculty') {
      return res.status(403).json({ message: 'Access denied: Faculty only' });
    }

    const supervisedTeams = await Team.find({
      'currentSupervisor.facultyId': req.user.id
    }).lean();

    // Enhance teams with progress data
    const teamsWithProgress = await Promise.all(
      supervisedTeams.map(async (team) => {
        // Get student details
        const memberStudentIds = team.members.map(member => member.studentId);
        const studentsWithDetails = await Student.find({
          studentId: { $in: memberStudentIds }
        }).select('studentId name email program completedCredits cgpa avatar phone');

        const studentDetailsMap = new Map(
          studentsWithDetails.map(student => [student.studentId, student])
        );

        const enhancedMembers = team.members.map(member => {
          const studentDetails = studentDetailsMap.get(member.studentId);
          return {
            ...member,
            email: studentDetails?.email || 'Not available',
            program: studentDetails?.program || 'Not specified',
            completedCredits: studentDetails?.completedCredits || 0,
            cgpa: studentDetails?.cgpa || 0.0,
            avatar: studentDetails?.avatar || null,
            phone: studentDetails?.phone || 'Not available'
          };
        });

        // Calculate average CGPA
        const validCGPAs = enhancedMembers.filter(m => m.cgpa > 0).map(m => m.cgpa);
        const averageCGPA = validCGPAs.length > 0 ? 
          validCGPAs.reduce((sum, cgpa) => sum + cgpa, 0) / validCGPAs.length : 0;

        // Get latest submission/deliverable info
        const latestSubmission = await DeliverableSubmission.findOne({
          teamId: team._id
        }).sort({ submittedAt: -1 }).populate('deliverableId', 'name');

        return {
          ...team,
          members: enhancedMembers,
          averageCGPA: averageCGPA.toFixed(2),
          // Initialize milestone tracking if not exists
          completedMilestones: team.completedMilestones || [],
          progressStatus: team.progressStatus || 'Not Set',
          statusNotes: team.statusNotes || '',
          latestSubmission: latestSubmission ? {
            title: latestSubmission.deliverableId?.name || 'Untitled',
            date: latestSubmission.submittedAt,
            status: latestSubmission.status
          } : null
        };
      })
    );

    res.json({
      success: true,
      teams: teamsWithProgress
    });

  } catch (error) {
    console.error('Get supervised teams progress error:', error);
    res.status(500).json({ message: 'Server error while fetching supervised teams progress' });
  }
});

// Update milestone status
app.put('/api/faculty/teams/:teamId/milestone', authenticate, async (req, res) => {
  try {
    const { teamId } = req.params;
    const { milestoneId, isCompleted } = req.body;

    if (req.user.role !== 'faculty') {
      return res.status(403).json({ message: 'Access denied: Faculty only' });
    }

    const team = await Team.findById(teamId);
    if (!team) {
      return res.status(404).json({ message: 'Team not found' });
    }

    // Verify faculty is the supervisor
    if (!team.currentSupervisor || team.currentSupervisor.facultyId.toString() !== req.user.id) {
      return res.status(403).json({ message: 'You are not the supervisor of this team' });
    }

    // Initialize completedMilestones array if it doesn't exist
    if (!team.completedMilestones) {
      team.completedMilestones = [];
    }

    if (isCompleted) {
      // Add milestone if not already completed
      if (!team.completedMilestones.includes(milestoneId)) {
        team.completedMilestones.push(milestoneId);
      }
    } else {
      // Remove milestone from completed list
      team.completedMilestones = team.completedMilestones.filter(id => id !== milestoneId);
    }

    team.lastProgressUpdate = new Date();
    await team.save();

    // Notify team members
    const faculty = await Faculty.findById(req.user.id);
    const teamMemberStudents = await Student.find({
      studentId: { $in: team.members.map(m => m.studentId) }
    });

    for (const student of teamMemberStudents) {
      const notification = new Notification({
        recipientId: student._id,
        recipientType: 'Student',
        type: 'general',
        recipientType: 'Student',
        title: 'Milestone Updated',
        message: `Your supervisor ${faculty.name} has ${isCompleted ? 'marked a milestone as completed' : 'unmarked a milestone'} for your team "${team.name}".`,        data: {
          teamId: team._id,
          teamName: team.name,
          milestoneId: milestoneId,
          isCompleted: isCompleted,
          action: 'milestone_update'
        },
        read: false
      });
      await notification.save();
    }

    res.json({
      success: true,
      message: 'Milestone updated successfully',
      completedMilestones: team.completedMilestones
    });

  } catch (error) {
    console.error('Update milestone error:', error);
    res.status(500).json({ message: 'Server error while updating milestone' });
  }
});

// Update team progress status
app.put('/api/faculty/teams/:teamId/progress-status', authenticate, async (req, res) => {
  try {
    const { teamId } = req.params;
    const { progressStatus, statusNotes } = req.body;

    if (req.user.role !== 'faculty') {
      return res.status(403).json({ message: 'Access denied: Faculty only' });
    }

    const validStatuses = ['On Track', 'Needs Improvement', 'Delayed', 'Completed'];
    if (!validStatuses.includes(progressStatus)) {
      return res.status(400).json({ message: 'Invalid progress status' });
    }

    const team = await Team.findById(teamId);
    if (!team) {
      return res.status(404).json({ message: 'Team not found' });
    }

    // Verify faculty is the supervisor
    if (!team.currentSupervisor || team.currentSupervisor.facultyId.toString() !== req.user.id) {
      return res.status(403).json({ message: 'You are not the supervisor of this team' });
    }

    team.progressStatus = progressStatus;
    team.statusNotes = statusNotes || '';
    team.lastProgressUpdate = new Date();
    await team.save();

    // Notify team members
    const faculty = await Faculty.findById(req.user.id);
    const teamMemberStudents = await Student.find({
      studentId: { $in: team.members.map(m => m.studentId) }
    });

    for (const student of teamMemberStudents) {
      const notification = new Notification({
        recipientId: student._id,
        recipientType: 'Student',
        type: 'general',
        title: 'Progress Status Updated',
        message: `Your supervisor ${faculty.name} has updated your team's progress status to: ${progressStatus}`,
        data: {
          teamId: team._id,
          teamName: team.name,
          progressStatus: progressStatus,
          statusNotes: statusNotes,
          action: 'progress_status_update'
        },
        read: false
      });
      await notification.save();
    }

    res.json({
      success: true,
      message: 'Progress status updated successfully',
      progressStatus: team.progressStatus,
      statusNotes: team.statusNotes
    });

  } catch (error) {
    console.error('Update progress status error:', error);
    res.status(500).json({ message: 'Server error while updating progress status' });
  }
});


app.post('/api/faculty/materials/upload', authenticate, upload.single('file'), async (req, res) => {
  try {
    if (req.user.role !== 'faculty') {
      return res.status(403).json({ message: 'Access denied: Faculty only' });
    }

    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    const { title, description, targetType, targetPhase, targetTeams, targetStudents } = req.body;

    // Validate required fields
    if (!title || !targetType) {
      return res.status(400).json({ message: 'Title and target type are required' });
    }

    // Validate target type specific requirements
    if (targetType === 'phase' && !targetPhase) {
      return res.status(400).json({ message: 'Target phase is required' });
    }
    if (targetType === 'teams' && (!targetTeams || JSON.parse(targetTeams).length === 0)) {
      return res.status(400).json({ message: 'At least one team must be selected' });
    }
    if (targetType === 'students' && (!targetStudents || JSON.parse(targetStudents).length === 0)) {
      return res.status(400).json({ message: 'At least one student must be selected' });
    }

    const faculty = await Faculty.findById(req.user.id);
    if (!faculty) {
      return res.status(404).json({ message: 'Faculty not found' });
    }

    // Upload to Cloudinary
    const fileStr = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    
    const timestamp = Date.now();
    const originalName = req.file.originalname.split('.')[0];
    const extension = req.file.originalname.split('.').pop();
    const uniqueFilename = `${originalName}_${timestamp}`;

    const uploadResponse = await cloudinary.uploader.upload(fileStr, {
      folder: 'student_files_chat',
      public_id: uniqueFilename,
      resource_type: 'auto',
      overwrite: false,
      unique_filename: true,
      use_filename: true,
    });

    // Create material record
    const material = new Material({
      title: title.trim(),
      description: description?.trim() || '',
      fileName: req.file.originalname,
      fileType: req.file.mimetype,
      fileSize: req.file.size,
      fileUrl: uploadResponse.secure_url,
      downloadUrl: uploadResponse.secure_url,
      cloudinaryId: uploadResponse.public_id,
      uploadedBy: faculty._id,
      uploadedByName: faculty.name,
      targetType,
      targetPhase: targetType === 'phase' ? targetPhase : undefined,
      targetTeams: targetType === 'teams' ? JSON.parse(targetTeams) : undefined,
      targetStudents: targetType === 'students' ? JSON.parse(targetStudents) : undefined
    });

    await material.save();

    // Create notifications for targeted audience
    await createMaterialNotifications(material);

    res.json({
      success: true,
      message: 'Material uploaded successfully',
      material: {
        id: material._id,
        title: material.title,
        fileName: material.fileName,
        fileUrl: material.fileUrl,
        targetType: material.targetType
      }
    });

  } catch (error) {
    console.error('Material upload error:', error);
    res.status(500).json({ 
      message: 'Failed to upload material',
      error: error.message 
    });
  }
});

// Get faculty's uploaded materials
app.get('/api/faculty/materials', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'faculty') {
      return res.status(403).json({ message: 'Access denied: Faculty only' });
    }

    const materials = await Material.find({
      uploadedBy: req.user.id,
      isActive: true
    })
    .populate('targetTeams', 'name')
    .populate('targetStudents', 'name studentId')
    .sort({ uploadDate: -1 });

    res.json({
      success: true,
      materials
    });

  } catch (error) {
    console.error('Get materials error:', error);
    res.status(500).json({ message: 'Failed to fetch materials' });
  }
});

// Delete material
// Delete material endpoint
app.delete('/api/faculty/materials/:materialId', authenticate, async (req, res) => {
  try {
    const { materialId } = req.params;
    
    // ✅ FIX: Use proper Mongoose ObjectId validation
    if (!mongoose.Types.ObjectId.isValid(materialId)) {
      return res.status(400).json({ 
        success: false,
        message: 'Invalid material ID format' 
      });
    }

    const material = await Material.findById(materialId);
    if (!material) {
      return res.status(404).json({ message: 'Material not found' });
    }

    // Verify the faculty owns this material or is admin
    if (req.user.role !== 'admin' && material.uploadedBy.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Unauthorized to delete this material' });
    }

    // Delete from Cloudinary
    try {
      if (material.cloudinaryId) {
        await cloudinary.uploader.destroy(material.cloudinaryId);
      }
    } catch (cloudinaryError) {
      console.error('Cloudinary deletion error:', cloudinaryError);
    }

    // Delete from database
    await Material.findByIdAndDelete(materialId);

    res.json({
      success: true,
      message: 'Material deleted successfully'
    });

  } catch (error) {
    console.error('Delete material error:', error);
    res.status(500).json({ message: 'Failed to delete material' });
  }
});


// Get materials for students

// Download material (track downloads)
app.get('/api/materials/:materialId/download', authenticate, async (req, res) => {
  try {
    const { materialId } = req.params;
    
     if (!mongoose.Types.ObjectId.isValid(materialId)) {
      return res.status(400).json({ 
        success: false,
        message: 'Invalid material ID format' 
      });
    }

    const material = await Material.findById(materialId);
    if (!material) {
      return res.status(404).json({ message: 'Material not found' });
    }

    // Check access permissions for students
    if (req.user.role === 'student') {
      const student = await Student.findById(req.user.id);
      const team = await Team.findOne({
        'members.studentId': student.studentId
      });
      const currentPhase = team?.currentPhase || team?.phase || 'A';

      let hasAccess = false;
      
      if (material.targetType === 'all') {
        hasAccess = true;
      } else if (material.targetType === 'phase' && material.targetPhase === currentPhase) {
        hasAccess = true;
      } else if (material.targetType === 'teams' && team && material.targetTeams.includes(team._id)) {
        hasAccess = true;
      } else if (material.targetType === 'students' && material.targetStudents.includes(req.user.id)) {
        hasAccess = true;
      }

      if (!hasAccess) {
        return res.status(403).json({ message: 'Access denied to this material' });
      }
    }

    // Increment download count
    await Material.findByIdAndUpdate(materialId, {
      $inc: { downloadCount: 1 }
    });

    // Redirect to Cloudinary URL
    res.redirect(material.downloadUrl);

  } catch (error) {
    console.error('Download material error:', error);
    res.status(500).json({ message: 'Failed to download material' });
  }
});

// Helper function to create notifications
const createMaterialNotifications = async (material) => {
  try {
    let recipients = [];
    
    if (material.targetType === 'all') {
      // Notify all active students
      const allStudents = await Student.find({ status: 'Active' }).select('_id');
      recipients = allStudents.map(s => s._id);
    } else if (material.targetType === 'phase') {
      // Notify students in specific phase
      const teamsInPhase = await Team.find({
        $or: [
          { currentPhase: material.targetPhase },
          { phase: material.targetPhase }
        ]
      });
      
      const studentIds = [];
      for (const team of teamsInPhase) {
        for (const member of team.members) {
          const student = await Student.findOne({ studentId: member.studentId });
          if (student) {
            studentIds.push(student._id);
          }
        }
      }
      recipients = studentIds;
    } else if (material.targetType === 'teams') {
      // Notify members of specific teams
      const teams = await Team.find({ _id: { $in: material.targetTeams } });
      const studentIds = [];
      
      for (const team of teams) {
        for (const member of team.members) {
          const student = await Student.findOne({ studentId: member.studentId });
          if (student) {
            studentIds.push(student._id);
          }
        }
      }
      recipients = studentIds;
    } else if (material.targetType === 'students') {
      recipients = material.targetStudents;
    }

    // Create notifications
    for (const studentId of recipients) {
      const notification = new Notification({
        recipientId: studentId,
        type: 'general',
        title: 'New Learning Material Available',
        message: `${material.uploadedByName} has shared a new material: "${material.title}"`,
        data: {
          materialId: material._id,
          materialTitle: material.title,
          facultyName: material.uploadedByName,
          action: 'material_shared'
        },
        read: false
      });
      
      await notification.save();
    }

  } catch (error) {
    console.error('Error creating material notifications:', error);
  }
};


// Get all active students for materials upload
app.get('/api/faculty/all-active-students', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'faculty') {
      return res.status(403).json({ message: 'Access denied: Faculty only' });
    }

    // Get ALL active students for materials upload
    const students = await Student.find({
      status: 'Active'
    }).select('_id name studentId email program').sort({ name: 1 });

    res.json({
      success: true,
      students
    });

  } catch (error) {
    console.error('Get all active students error:', error);
    res.status(500).json({ message: 'Failed to fetch students' });
  }
});


// Get faculty's supervised students
app.get('/api/faculty/all-students', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'faculty') {
      return res.status(403).json({ message: 'Access denied: Faculty only' });
    }

    // Get all teams supervised by this faculty
    const supervisedTeams = await Team.find({
      'currentSupervisor.facultyId': req.user.id
    });

    // Extract all student IDs from supervised teams
    const studentIds = [];
    supervisedTeams.forEach(team => {
      team.members.forEach(member => {
        studentIds.push(member.studentId);
      });
    });

    // Get student details
    const students = await Student.find({
      studentId: { $in: studentIds },
      status: 'Active'
    }).select('_id name studentId email program');

    res.json({
      success: true,
      students
    });

  } catch (error) {
    console.error('Get faculty students error:', error);
    res.status(500).json({ message: 'Failed to fetch students' });
  }
});


// ===== DELIVERABLES API ENDPOINTS =====

// Faculty: Create deliverable for supervised team
app.post('/api/faculty/deliverables', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'faculty') {
      return res.status(403).json({ message: 'Access denied: Faculty only' });
    }

    const { 
      teamId, 
      name, 
      description, 
      phase, 
      deadline, 
      allowedFileTypes, 
      maxFileSize 
    } = req.body;

    // Verify faculty supervises this team
    const team = await Team.findOne({
      _id: teamId,
      'currentSupervisor.facultyId': req.user.id
    });

    if (!team) {
      return res.status(404).json({ message: 'Team not found or you are not the supervisor' });
    }

    const deliverable = new Deliverable({
      teamId,
      supervisorId: req.user.id,
      name: name.trim(),
      description: description?.trim() || '',
      phase,
      deadline: new Date(deadline),
      allowedFileTypes: allowedFileTypes || ['pdf', 'docx', 'zip', 'pptx'],
      maxFileSize: maxFileSize || 20
    });

    await deliverable.save();

    // Notify team members
    const teamMemberStudents = await Student.find({
      studentId: { $in: team.members.map(m => m.studentId) }
    });

    const faculty = await Faculty.findById(req.user.id);

    for (const student of teamMemberStudents) {
      const notification = new Notification({
        recipientId: student._id,
        recipientType: 'Student',
        type: 'general',
        title: 'New Deliverable Assigned',
        message: `Your supervisor ${faculty.name} has assigned a new deliverable: "${name}" for Phase ${phase}`,
        data: {
          teamId: team._id,
          deliverableId: deliverable._id,
          deliverableName: name,
          phase: phase,
          deadline: deadline
        },
        read: false
      });
      await notification.save();
    }

    res.json({
      success: true,
      message: 'Deliverable created successfully',
      deliverable
    });

  } catch (error) {
    console.error('Create deliverable error:', error);
    res.status(500).json({ message: 'Server error while creating deliverable' });
  }
});

// Faculty: Get deliverables for supervised teams
app.get('/api/faculty/deliverables', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'faculty') {
      return res.status(403).json({ message: 'Access denied: Faculty only' });
    }

    const deliverables = await Deliverable.find({
      supervisorId: req.user.id,
      isActive: true
    })
    .populate('teamId', 'name members')
    .sort({ deadline: 1 });

    // Get submission counts for each deliverable
    const deliverablesWithStats = await Promise.all(
      deliverables.map(async (deliverable) => {
        const submissionCount = await DeliverableSubmission.countDocuments({
          deliverableId: deliverable._id,
          isLatest: true
        });

        const pendingCount = await DeliverableSubmission.countDocuments({
          deliverableId: deliverable._id,
          isLatest: true,
          status: 'pending'
        });

        return {
          ...deliverable.toObject(),
          submissionCount,
          pendingCount,
          isOverdue: new Date() > deliverable.deadline
        };
      })
    );

    res.json({
      success: true,
      deliverables: deliverablesWithStats
    });

  } catch (error) {
    console.error('Get faculty deliverables error:', error);
    res.status(500).json({ message: 'Server error while fetching deliverables' });
  }
});

// Faculty: Get submissions for a specific deliverable
app.get('/api/faculty/deliverables/:deliverableId/submissions', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'faculty') {
      return res.status(403).json({ message: 'Access denied: Faculty only' });
    }

    const { deliverableId } = req.params;

    // Verify faculty owns this deliverable
    const deliverable = await Deliverable.findOne({
      _id: deliverableId,
      supervisorId: req.user.id
    }).populate('teamId', 'name members');

    if (!deliverable) {
      return res.status(404).json({ message: 'Deliverable not found' });
    }

    const submissions = await DeliverableSubmission.find({
      deliverableId,
      isLatest: true
    })
    .populate('submittedBy', 'name studentId email')
    .sort({ submittedAt: -1 });

    res.json({
      success: true,
      deliverable,
      submissions
    });

  } catch (error) {
    console.error('Get submissions error:', error);
    res.status(500).json({ message: 'Server error while fetching submissions' });
  }
});

// Faculty: Review submission (add feedback, marks, approve/reject)
app.put('/api/faculty/submissions/:submissionId/review', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'faculty') {
      return res.status(403).json({ message: 'Access denied: Faculty only' });
    }

    const { submissionId } = req.params;
    const { status, feedback, marks } = req.body;

    const submission = await DeliverableSubmission.findById(submissionId)
      .populate('deliverableId')
      .populate('teamId', 'name members')
      .populate('submittedBy', 'name studentId');

    if (!submission) {
      return res.status(404).json({ message: 'Submission not found' });
    }

    // Verify faculty supervises this team
    if (submission.deliverableId.supervisorId.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Access denied: Not your supervised team' });
    }

    // Update submission
    submission.status = status;
    submission.feedback = feedback || '';
    submission.marks = marks;
    submission.reviewedBy = req.user.id;
    submission.reviewedAt = new Date();

    await submission.save();

    // Notify team members
    const faculty = await Faculty.findById(req.user.id);
    const teamMemberStudents = await Student.find({
      studentId: { $in: submission.teamId.members.map(m => m.studentId) }
    });

    const statusMessages = {
      'approved': 'has been approved',
      'rejected': 'has been rejected',
      'needs_revision': 'needs revision'
    };

    for (const student of teamMemberStudents) {
      const notification = new Notification({
        recipientId: student._id,
        recipientType: 'Student',
        type: 'general',
        title: 'Deliverable Reviewed',
        message: `Your submission for "${submission.deliverableId.name}" ${statusMessages[status]} by ${faculty.name}`,
        data: {
          deliverableId: submission.deliverableId._id,
          submissionId: submission._id,
          status: status,
          marks: marks,
          feedback: feedback
        },
        read: false
      });
      await notification.save();
    }

    res.json({
      success: true,
      message: 'Submission reviewed successfully',
      submission
    });

  } catch (error) {
    console.error('Review submission error:', error);
    res.status(500).json({ message: 'Server error while reviewing submission' });
  }
});


// Student: Upload deliverable submission
app.post('/api/students/deliverables/:deliverableId/submit', authenticate, upload.single('file'), async (req, res) => {
  try {
    if (req.user.role !== 'student') {
      return res.status(403).json({ message: 'Access denied: Students only' });
    }

    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    const { deliverableId } = req.params;
    const student = await Student.findById(req.user.id);

    // Find student's team and verify they're the leader
    const team = await Team.findOne({
      'members.studentId': student.studentId
    });

    if (!team) {
      return res.status(404).json({ message: 'Team not found' });
    }

    const teamMember = team.members.find(m => m.studentId === student.studentId);
    if (!teamMember || teamMember.role !== 'Leader') {
      return res.status(403).json({ message: 'Only team leaders can upload deliverables' });
    }

    // Get deliverable details
    const deliverable = await Deliverable.findOne({
      _id: deliverableId,
      teamId: team._id,
      isActive: true
    });

    if (!deliverable) {
      return res.status(404).json({ message: 'Deliverable not found' });
    }

    // Check file type
    const fileExtension = req.file.originalname.split('.').pop().toLowerCase();
    if (!deliverable.allowedFileTypes.includes(fileExtension)) {
      return res.status(400).json({ 
        message: `File type .${fileExtension} not allowed. Allowed types: ${deliverable.allowedFileTypes.join(', ')}` 
      });
    }

    // Check file size
    const fileSizeInMB = req.file.size / (1024 * 1024);
    if (fileSizeInMB > deliverable.maxFileSize) {
      return res.status(400).json({ 
        message: `File size ${fileSizeInMB.toFixed(2)}MB exceeds limit of ${deliverable.maxFileSize}MB` 
      });
    }

    // Upload to Cloudinary
    const uploadResult = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          resource_type: 'auto',
          folder: `deliverables/${team._id}/${deliverableId}`,
          public_id: `${Date.now()}_${req.file.originalname}`,
          use_filename: true,
          unique_filename: true
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );
      stream.end(req.file.buffer);
    });

    // Mark previous submissions as not latest
    await DeliverableSubmission.updateMany(
      { deliverableId, teamId: team._id },
      { isLatest: false }
    );

    // Get version number
    const previousSubmissions = await DeliverableSubmission.countDocuments({
      deliverableId,
      teamId: team._id
    });

    // Create new submission
    const submission = new DeliverableSubmission({
      deliverableId,
      teamId: team._id,
      submittedBy: req.user.id,
      submitterName: student.name,
      fileName: uploadResult.public_id,
      originalName: req.file.originalname,
      fileSize: req.file.size,
      fileType: fileExtension,
      cloudinaryId: uploadResult.public_id,
      fileUrl: uploadResult.secure_url,
      version: previousSubmissions + 1,
      isLatest: true
    });

    await submission.save();

    await createNotification(
      deliverable.supervisorId,
      'Faculty',
      'deliverable_submitted',
      'New Deliverable Submission',
      `Team "${team.name}" has submitted "${deliverable.name}" for review`,
      {
        teamId: team._id.toString(),
        teamName: team.name,
        deliverableId: deliverable._id.toString(),
        deliverableName: deliverable.name,
        submissionId: submission._id.toString(),
        senderName: student.name,
        senderStudentId: student.studentId
      }
    );

    
    res.json({
      success: true,
      message: 'Deliverable submitted successfully',
      submission
    });

  } catch (error) {
    console.error('Submit deliverable error:', error);
    res.status(500).json({ 
      message: 'Server error while submitting deliverable',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Download deliverable file
app.get('/api/deliverables/submissions/:submissionId/download', authenticate, async (req, res) => {
  try {
    const { submissionId } = req.params;
    
    const submission = await DeliverableSubmission.findById(submissionId)
      .populate('deliverableId')
      .populate('teamId', 'name members');

    if (!submission) {
      return res.status(404).json({ message: 'Submission not found' });
    }

    // Check authorization
    if (req.user.role === 'student') {
      const student = await Student.findById(req.user.id);
      const isTeamMember = submission.teamId.members.some(m => m.studentId === student.studentId);
      if (!isTeamMember) {
        return res.status(403).json({ message: 'Access denied' });
      }
    } else if (req.user.role === 'faculty') {
      if (submission.deliverableId.supervisorId.toString() !== req.user.id) {
        return res.status(403).json({ message: 'Access denied' });
      }
    } else {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Redirect to Cloudinary URL
    res.redirect(submission.fileUrl);

  } catch (error) {
    console.error('Download deliverable error:', error);
    res.status(500).json({ message: 'Server error while downloading file' });
  }
});

// ===== ADMIN DELIVERABLES API ENDPOINTS =====

// Admin: Get all deliverable submissions across all teams
app.get('/api/admin/deliverables', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied: Admin only' });
    }

    const submissions = await DeliverableSubmission.find({ isLatest: true })
      .populate({
        path: 'deliverableId',
        populate: {
          path: 'supervisorId',
          select: 'name email department'
        }
      })
      .populate('teamId', 'name members currentSupervisor')
      .populate('submittedBy', 'name studentId email')
      .sort({ submittedAt: -1 });

    // Enhance submissions with team and supervisor info
    const enhancedSubmissions = submissions.map(submission => {
      const teamName = submission.teamId?.name || 'Unknown Team';
      const supervisorName = submission.teamId?.currentSupervisor?.facultyName || 
                           submission.deliverableId?.supervisorId?.name || 'No Supervisor';
      
      return {
        ...submission.toObject(),
        teamName,
        supervisorName,
        name: submission.deliverableId?.name || 'Unknown Deliverable',
        phase: submission.deliverableId?.phase || 'A',
        deadline: submission.deliverableId?.deadline
      };
    });

    res.json({
      success: true,
      submissions: enhancedSubmissions
    });

  } catch (error) {
    console.error('Admin get deliverables error:', error);
    res.status(500).json({ message: 'Server error while fetching deliverables' });
  }
});

// Admin: Update deliverable status
app.put('/api/admin/deliverables/:deliverableId/status', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied: Admin only' });
    }

    const { deliverableId } = req.params;
    const { status } = req.body;

    if (!['pending', 'approved', 'rejected', 'needs_revision'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    const submission = await DeliverableSubmission.findByIdAndUpdate(
      deliverableId,
      { 
        status,
        reviewedAt: new Date(),
        reviewedBy: req.user.id
      },
      { new: true }
    ).populate('teamId', 'name members')
     .populate('deliverableId', 'name');

    if (!submission) {
      return res.status(404).json({ message: 'Submission not found' });
    }

    // Notify team members
    if (submission.teamId?.members) {
      const teamMemberStudents = await Student.find({
        studentId: { $in: submission.teamId.members.map(m => m.studentId) }
      });

      const statusMessages = {
        'approved': 'has been approved by admin',
        'rejected': 'has been rejected by admin',
        'needs_revision': 'needs revision (admin review)'
      };

      for (const student of teamMemberStudents) {
        const notification = new Notification({
          recipientId: student._id,
          recipientType: 'Student',
          type: 'general',
          title: 'Deliverable Status Updated',
          message: `Your submission "${submission.deliverableId.name}" ${statusMessages[status]}`,
          data: {
            deliverableId: submission.deliverableId._id,
            submissionId: submission._id,
            status: status,
            updatedBy: 'Administrator'
          },
          read: false
        });
        await notification.save();
      }
    }

    res.json({
      success: true,
      message: `Deliverable ${status} successfully`,
      submission
    });

  } catch (error) {
    console.error('Admin update deliverable status error:', error);
    res.status(500).json({ message: 'Server error while updating status' });
  }
});

// Admin: Add feedback to deliverable
app.put('/api/admin/deliverables/:deliverableId/feedback', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied: Admin only' });
    }

    const { deliverableId } = req.params;
    const { status, feedback, marks } = req.body;

    const submission = await DeliverableSubmission.findByIdAndUpdate(
      deliverableId,
      {
        status,
        feedback: feedback || '',
        marks: marks ? parseInt(marks) : null,
        reviewedBy: req.user.id,
        reviewedAt: new Date()
      },
      { new: true }
    ).populate('teamId', 'name members')
     .populate('deliverableId', 'name');

    if (!submission) {
      return res.status(404).json({ message: 'Submission not found' });
    }

    // Notify team members
    if (submission.teamId?.members) {
      const teamMemberStudents = await Student.find({
        studentId: { $in: submission.teamId.members.map(m => m.studentId) }
      });

      for (const student of teamMemberStudents) {
        const notification = new Notification({
          recipientId: student._id,
          recipientType: 'Student',
          type: 'general',
          title: 'Deliverable Feedback Received',
          message: `Administrator provided feedback for "${submission.deliverableId.name}": ${feedback.substring(0, 100)}...`,
          data: {
            deliverableId: submission.deliverableId._id,
            submissionId: submission._id,
            status: status,
            feedback: feedback,
            marks: marks
          },
          read: false
        });
        await notification.save();
      }
    }

    res.json({
      success: true,
      message: 'Feedback submitted successfully',
      submission
    });

  } catch (error) {
    console.error('Admin feedback error:', error);
    res.status(500).json({ message: 'Server error while submitting feedback' });
  }
});

// Admin: Download deliverable
app.get('/api/admin/deliverables/:deliverableId/download', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied: Admin only' });
    }

    const { deliverableId } = req.params;
    
    const submission = await DeliverableSubmission.findById(deliverableId);
    if (!submission) {
      return res.status(404).json({ message: 'Submission not found' });
    }

    // Set headers for file download
    res.setHeader('Content-Disposition', `attachment; filename="${submission.originalName}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    
    // Redirect to Cloudinary URL
    res.redirect(submission.fileUrl);

  } catch (error) {
    console.error('Admin download error:', error);
    res.status(500).json({ message: 'Server error while downloading file' });
  }
});

// Admin: Get/Update deliverable global settings
app.get('/api/admin/deliverables/settings', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied: Admin only' });
    }

    // For now, return default settings. You can store these in a separate collection if needed
    const defaultSettings = {
      allowResubmissions: true,
      autoNotifyFaculty: true,
      maxFileSize: 20, // MB
      allowedFileTypes: ['pdf', 'docx', 'zip', 'pptx', 'txt']
    };

    res.json({
      success: true,
      settings: defaultSettings
    });

  } catch (error) {
    console.error('Get deliverable settings error:', error);
    res.status(500).json({ message: 'Server error while fetching settings' });
  }
});

app.put('/api/admin/deliverables/settings', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied: Admin only' });
    }

    const { allowResubmissions, autoNotifyFaculty } = req.body;

    // For now, just return success. In production, you'd save these to database
    res.json({
      success: true,
      message: 'Settings updated successfully',
      settings: {
        allowResubmissions,
        autoNotifyFaculty
      }
    });

  } catch (error) {
    console.error('Update deliverable settings error:', error);
    res.status(500).json({ message: 'Server error while updating settings' });
  }
});


// Get notifications for faculty
app.get('/api/faculty/notifications', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'faculty') {
      return res.status(403).json({ message: 'Access denied: Faculty only' });
    }

    const { page = 1, limit = 20 } = req.query;
    
    const notifications = await Notification.find({
      recipientId: req.user.id,
      recipientType: 'Faculty'
    })
    .sort({ createdAt: -1 })
    .limit(limit * 1)
    .skip((page - 1) * limit);

    const unreadCount = await Notification.countDocuments({
      recipientId: req.user.id,
      recipientType: 'Faculty',
      read: false
    });

    res.json({
      success: true,
      notifications,
      unreadCount,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: await Notification.countDocuments({
          recipientId: req.user.id,
          recipientType: 'Faculty'
        })
      }
    });

  } catch (error) {
    console.error('Get faculty notifications error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Mark faculty notification as read
app.put('/api/faculty/notifications/:id/read', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'faculty') {
      return res.status(403).json({ message: 'Access denied: Faculty only' });
    }

    const notification = await Notification.findOneAndUpdate(
      { 
        _id: req.params.id, 
        recipientId: req.user.id,
        recipientType: 'Faculty'
      },
      { read: true },
      { new: true }
    );

    if (!notification) {
      return res.status(404).json({ message: 'Notification not found' });
    }

    res.json({
      success: true,
      notification
    });

  } catch (error) {
    console.error('Mark notification read error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Mark all faculty notifications as read
app.put('/api/faculty/notifications/mark-all-read', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'faculty') {
      return res.status(403).json({ message: 'Access denied: Faculty only' });
    }

    await Notification.updateMany(
      { 
        recipientId: req.user.id,
        recipientType: 'Faculty',
        read: false
      },
      { read: true }
    );

    res.json({
      success: true,
      message: 'All notifications marked as read'
    });

  } catch (error) {
    console.error('Mark all notifications read error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get unread notification count for faculty
app.get('/api/faculty/notifications/unread-count', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'faculty') {
      return res.status(403).json({ message: 'Access denied: Faculty only' });
    }

    const count = await Notification.countDocuments({
      recipientId: req.user.id,
      recipientType: 'Faculty',
      read: false
    });

    res.json({ success: true, count });

  } catch (error) {
    console.error('Get unread count error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});


// Create custom milestone
app.post('/api/faculty/teams/:teamId/custom-milestone', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'faculty') {
      return res.status(403).json({ message: 'Access denied: Faculty only' });
    }

    const { teamId } = req.params;
    const { name, description, phase, weight, dueDate } = req.body;

    // Verify faculty supervises this team
    const team = await Team.findOne({
      _id: teamId,
      'currentSupervisor.facultyId': req.user.id
    });

    if (!team) {
      return res.status(404).json({ message: 'Team not found or you are not the supervisor' });
    }

    // Validate input
    if (!name || name.trim().length === 0) {
      return res.status(400).json({ message: 'Milestone name is required' });
    }

    if (!['A', 'B', 'C'].includes(phase)) {
      return res.status(400).json({ message: 'Invalid phase' });
    }

    if (weight < 1 || weight > 100) {
      return res.status(400).json({ message: 'Weight must be between 1 and 100' });
    }

    // Create unique ID for the milestone
    const milestoneId = `custom_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const customMilestone = new CustomMilestone({
      teamId,
      supervisorId: req.user.id,
      name: name.trim(),
      description: description?.trim() || '',
      phase,
      weight: parseInt(weight),
      dueDate: dueDate ? new Date(dueDate) : null,
      id: milestoneId
    });

    await customMilestone.save();

    // Notify team members
    const faculty = await Faculty.findById(req.user.id);
    const teamMemberStudents = await Student.find({
      studentId: { $in: team.members.map(m => m.studentId) }
    });

    for (const student of teamMemberStudents) {
      const notification = new Notification({
        recipientId: student._id,
        recipientType: 'Student',
        type: 'general',
        title: 'New Custom Milestone Added',
        message: `Your supervisor ${faculty.name} has added a new milestone "${name}" for Phase ${phase}`,
        data: {
          teamId: team._id,
          teamName: team.name,
          milestoneName: name,
          phase: phase
        },
        read: false
      });
      await notification.save();
    }

    res.json({
      success: true,
      message: 'Custom milestone created successfully',
      milestone: customMilestone
    });

  } catch (error) {
    console.error('Create custom milestone error:', error);
    res.status(500).json({ message: 'Server error while creating milestone' });
  }
});

// Get custom milestones for supervised teams
app.get('/api/faculty/custom-milestones', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'faculty') {
      return res.status(403).json({ message: 'Access denied: Faculty only' });
    }

    const customMilestones = await CustomMilestone.find({
      supervisorId: req.user.id,
      isActive: true
    }).populate('teamId', 'name');

    // Group milestones by team ID
    const milestonesByTeam = {};
    customMilestones.forEach(milestone => {
      if (milestone.teamId) {
        const teamId = milestone.teamId._id.toString();
        if (!milestonesByTeam[teamId]) {
          milestonesByTeam[teamId] = [];
        }
        
        milestonesByTeam[teamId].push({
          id: milestone.id || milestone._id.toString(),
          name: milestone.name,
          description: milestone.description,
          phase: milestone.phase,
          weight: milestone.weight,
          dueDate: milestone.dueDate,
          createdAt: milestone.createdAt
        });
      }
    });

    res.json({
      success: true,
      milestones: milestonesByTeam
    });

  } catch (error) {
    console.error('Get custom milestones error:', error);
    res.status(500).json({ message: 'Server error while fetching custom milestones' });
  }
});

// Delete custom milestone
app.delete('/api/faculty/custom-milestones/:milestoneId', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'faculty') {
      return res.status(403).json({ message: 'Access denied: Faculty only' });
    }

    const { milestoneId } = req.params;

    const milestone = await CustomMilestone.findOneAndUpdate(
      {
        _id: milestoneId,
        supervisorId: req.user.id
      },
      { isActive: false },
      { new: true }
    );

    if (!milestone) {
      return res.status(404).json({ message: 'Milestone not found' });
    }

    res.json({
      success: true,
      message: 'Custom milestone deleted successfully'
    });

  } catch (error) {
    console.error('Delete custom milestone error:', error);
    res.status(500).json({ message: 'Server error while deleting milestone' });
  }
});

// Update custom milestone
app.put('/api/faculty/custom-milestones/:milestoneId', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'faculty') {
      return res.status(403).json({ message: 'Access denied: Faculty only' });
    }

    const { milestoneId } = req.params;
    const { name, description, phase, weight, dueDate } = req.body;

    const milestone = await CustomMilestone.findOneAndUpdate(
      {
        _id: milestoneId,
        supervisorId: req.user.id
      },
      {
        name: name.trim(),
        description: description?.trim() || '',
        phase,
        weight: parseInt(weight),
        dueDate: dueDate ? new Date(dueDate) : null
      },
      { new: true }
    );

    if (!milestone) {
      return res.status(404).json({ message: 'Milestone not found' });
    }

    res.json({
      success: true,
      message: 'Custom milestone updated successfully',
      milestone
    });

  } catch (error) {
    console.error('Update custom milestone error:', error);
    res.status(500).json({ message: 'Server error while updating milestone' });
  }
});


// Get supervisor's customized predefined milestones
app.get('/api/faculty/predefined-milestones', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'faculty') {
      return res.status(403).json({ message: 'Access denied: Faculty only' });
    }

    const customizedMilestones = await CustomPredefinedMilestone.find({
      supervisorId: req.user.id,
      isActive: true
    });

    // Group by phase
    const milestonesByPhase = {};
    customizedMilestones.forEach(milestone => {
      if (!milestonesByPhase[milestone.phase]) {
        milestonesByPhase[milestone.phase] = [];
      }
      milestonesByPhase[milestone.phase].push({
        id: milestone.milestoneId,
        name: milestone.name,
        weight: milestone.weight,
        description: milestone.description,
        isCustomized: true
      });
    });

    res.json({
      success: true,
      customizedMilestones: milestonesByPhase
    });

  } catch (error) {
    console.error('Error fetching predefined milestones:', error);
    res.status(500).json({ message: 'Server error while fetching predefined milestones' });
  }
});

// Update predefined milestone
app.put('/api/faculty/predefined-milestones/:milestoneId', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'faculty') {
      return res.status(403).json({ message: 'Access denied: Faculty only' });
    }

    const { milestoneId } = req.params;
    const { name, weight, description, phase } = req.body;

    // Validate input
    if (!name || !name.trim()) {
      return res.status(400).json({ message: 'Milestone name is required' });
    }

    if (weight < 1 || weight > 100) {
      return res.status(400).json({ message: 'Weight must be between 1 and 100' });
    }

    // Check if customization already exists
    let customMilestone = await CustomPredefinedMilestone.findOne({
      supervisorId: req.user.id,
      milestoneId: milestoneId,
      phase: phase
    });

    if (customMilestone) {
      // Update existing customization
      customMilestone.name = name.trim();
      customMilestone.weight = parseInt(weight);
      customMilestone.description = description?.trim() || '';
      await customMilestone.save();
    } else {
      // Create new customization
      customMilestone = new CustomPredefinedMilestone({
        supervisorId: req.user.id,
        phase: phase,
        milestoneId: milestoneId,
        name: name.trim(),
        weight: parseInt(weight),
        description: description?.trim() || ''
      });
      await customMilestone.save();
    }

    res.json({
      success: true,
      message: 'Predefined milestone updated successfully',
      milestone: customMilestone
    });

  } catch (error) {
    console.error('Error updating predefined milestone:', error);
    res.status(500).json({ message: 'Server error while updating predefined milestone' });
  }
});

// Reset predefined milestone to default
app.delete('/api/faculty/predefined-milestones/:milestoneId/:phase', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'faculty') {
      return res.status(403).json({ message: 'Access denied: Faculty only' });
    }

    const { milestoneId, phase } = req.params;

    await CustomPredefinedMilestone.findOneAndDelete({
      supervisorId: req.user.id,
      milestoneId: milestoneId,
      phase: phase
    });

    res.json({
      success: true,
      message: 'Predefined milestone reset to default successfully'
    });

  } catch (error) {
    console.error('Error resetting predefined milestone:', error);
    res.status(500).json({ message: 'Server error while resetting predefined milestone' });
  }
});


// ===== BOARD MANAGEMENT API ENDPOINTS =====

// Get all boards (Admin)
app.get('/api/admin/boards', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }

    const boards = await Board.find({ isActive: true })
      .sort({ createdAt: -1 })
      .lean();

    // Calculate supervised teams for each faculty member
    const boardsWithTeamCounts = await Promise.all(
      boards.map(async (board) => {
        // Get teams supervised by faculty in this board
        const facultyIds = board.faculty.map(f => f._id);
        const supervisedTeams = await Team.find({
          'currentSupervisor.facultyId': { $in: facultyIds }
        }).lean();

        // Add supervised team info to faculty
        const facultyWithTeams = await Promise.all(
          board.faculty.map(async (faculty) => {
            const facultyTeams = supervisedTeams.filter(
              team => team.currentSupervisor?.facultyId?.toString() === faculty._id.toString()
            );

            return {
              ...faculty,
              supervisedTeams: facultyTeams.map(team => ({
                _id: team._id,
                name: team.name,
                memberCount: team.memberCount || team.members?.length || 0,
                status: team.status,
                currentPhase: team.currentPhase || 'A'
              }))
            };
          })
        );

        return {
          ...board,
          faculty: facultyWithTeams,
          totalTeams: supervisedTeams.length
        };
      })
    );

    res.json({
      success: true,
      boards: boardsWithTeamCounts
    });

  } catch (error) {
    console.error('Get boards error:', error);
    res.status(500).json({ message: 'Server error while fetching boards' });
  }
});

// Create new board (Admin)
app.post('/api/admin/boards', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }

    const { name, description, faculty } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ message: 'Board name is required' });
    }

    // Check if board name already exists
    const existingBoard = await Board.findOne({ 
      name: name.trim(), 
      isActive: true 
    });

    if (existingBoard) {
      return res.status(400).json({ message: 'Board with this name already exists' });
    }

    // Validate faculty members
    const facultyMembers = [];
    if (faculty && Array.isArray(faculty)) {
      for (const facultyId of faculty) {
        const facultyDoc = await Faculty.findById(facultyId);
        if (facultyDoc) {
          facultyMembers.push({
            _id: facultyDoc._id,
            name: facultyDoc.name,
            email: facultyDoc.email,
            department: facultyDoc.department,
            assignedDate: new Date()
          });
        }
      }
    }

    const newBoard = new Board({
      name: name.trim(),
      description: description?.trim() || '',
      faculty: facultyMembers
    });

    await newBoard.save();

    // Create notifications for assigned faculty
    for (const facultyMember of facultyMembers) {
      try {
        const notification = new Notification({
          recipientId: facultyMember._id,
          recipientType: 'Faculty',
          type: 'general',
          title: 'Assigned to Evaluation Board',
          message: `You have been assigned to the evaluation board "${newBoard.name}".`,
          data: {
            boardId: newBoard._id,
            boardName: newBoard.name,
            action: 'board_assignment'
          },
          read: false
        });
        await notification.save();
      } catch (notifError) {
        console.error('Error creating board assignment notification:', notifError);
      }
    }

    res.status(201).json({
      success: true,
      message: 'Board created successfully',
      board: newBoard
    });

  } catch (error) {
    console.error('Create board error:', error);
    res.status(500).json({ message: 'Server error while creating board' });
  }
});

// Update board (Admin)
app.put('/api/admin/boards/:boardId', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }

    const { boardId } = req.params;
    const { name, description, faculty } = req.body;

    const board = await Board.findById(boardId);
    if (!board) {
      return res.status(404).json({ message: 'Board not found' });
    }

    // Check if new name conflicts with existing boards
    if (name && name.trim() !== board.name) {
      const existingBoard = await Board.findOne({ 
        name: name.trim(), 
        isActive: true,
        _id: { $ne: boardId }
      });

      if (existingBoard) {
        return res.status(400).json({ message: 'Board with this name already exists' });
      }
    }

    // Store previous faculty for comparison
    const previousFaculty = board.faculty.map(f => f._id.toString());

    // Update basic info
    if (name) board.name = name.trim();
    if (description !== undefined) board.description = description.trim();

    // Update faculty members
    const facultyMembers = [];
    if (faculty && Array.isArray(faculty)) {
      for (const facultyId of faculty) {
        const facultyDoc = await Faculty.findById(facultyId);
        if (facultyDoc) {
          // Keep existing assignment date if faculty was already assigned
          const existingFaculty = board.faculty.find(
            f => f._id.toString() === facultyId.toString()
          );
          
          facultyMembers.push({
            _id: facultyDoc._id,
            name: facultyDoc.name,
            email: facultyDoc.email,
            department: facultyDoc.department,
            assignedDate: existingFaculty?.assignedDate || new Date()
          });
        }
      }
    }

    board.faculty = facultyMembers;
    board.updatedAt = new Date();

    await board.save();

    // Notify newly added faculty
    const currentFaculty = facultyMembers.map(f => f._id.toString());
    const newlyAdded = currentFaculty.filter(id => !previousFaculty.includes(id));
    const removed = previousFaculty.filter(id => !currentFaculty.includes(id));

    // Notify newly added faculty
    for (const facultyId of newlyAdded) {
      try {
        const notification = new Notification({
          recipientId: facultyId,
          recipientType: 'Faculty',
          type: 'general',
          title: 'Assigned to Evaluation Board',
          message: `You have been assigned to the evaluation board "${board.name}".`,
          data: {
            boardId: board._id,
            boardName: board.name,
            action: 'board_assignment'
          },
          read: false
        });
        await notification.save();
      } catch (notifError) {
        console.error('Error creating assignment notification:', notifError);
      }
    }

    // Notify removed faculty
    for (const facultyId of removed) {
      try {
        const notification = new Notification({
          recipientId: facultyId,
          recipientType: 'Faculty',
          type: 'general',
          title: 'Removed from Evaluation Board',
          message: `You have been removed from the evaluation board "${board.name}".`,
          data: {
            boardId: board._id,
            boardName: board.name,
            action: 'board_removal'
          },
          read: false
        });
        await notification.save();
      } catch (notifError) {
        console.error('Error creating removal notification:', notifError);
      }
    }

    res.json({
      success: true,
      message: 'Board updated successfully',
      board: board
    });

  } catch (error) {
    console.error('Update board error:', error);
    res.status(500).json({ message: 'Server error while updating board' });
  }
});

// Delete board (Admin)
app.delete('/api/admin/boards/:boardId', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }

    const { boardId } = req.params;

    const board = await Board.findById(boardId);
    if (!board) {
      return res.status(404).json({ message: 'Board not found' });
    }

    // Notify all faculty members about board deletion
    for (const facultyMember of board.faculty) {
      try {
        const notification = new Notification({
          recipientId: facultyMember._id,
          recipientType: 'Faculty',
          type: 'general',
          title: 'Evaluation Board Deleted',
          message: `The evaluation board "${board.name}" has been deleted by administration.`,
          data: {
            boardName: board.name,
            action: 'board_deletion'
          },
          read: false
        });
        await notification.save();
      } catch (notifError) {
        console.error('Error creating deletion notification:', notifError);
      }
    }

    // Soft delete - mark as inactive instead of hard delete
    board.isActive = false;
    board.updatedAt = new Date();
    await board.save();

    res.json({
      success: true,
      message: 'Board deleted successfully'
    });

  } catch (error) {
    console.error('Delete board error:', error);
    res.status(500).json({ message: 'Server error while deleting board' });
  }
});

// Get available faculty for board assignment
app.get('/api/admin/faculty/available-for-board', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }

    const { exclude } = req.query;

    // Get all active faculty
    let availableFaculty = await Faculty.find({
      status: 'Active'
    }).select('_id name email department role').sort({ name: 1 });

    // If excluding a specific board, don't filter out its faculty
    if (exclude) {
      // This allows editing existing boards without losing current faculty
      res.json({
        success: true,
        faculty: availableFaculty
      });
    } else {
      // For new boards, show all available faculty
      res.json({
        success: true,
        faculty: availableFaculty
      });
    }

  } catch (error) {
    console.error('Get available faculty error:', error);
    res.status(500).json({ message: 'Server error while fetching available faculty' });
  }
});

// Get board statistics
app.get('/api/admin/boards/statistics', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }

    const totalBoards = await Board.countDocuments({ isActive: true });
    
    const boards = await Board.find({ isActive: true }).lean();
    const totalFacultyAssignments = boards.reduce((sum, board) => sum + board.faculty.length, 0);
    
    // Count total supervised teams
    const allFacultyIds = boards.flatMap(board => board.faculty.map(f => f._id));
    const totalTeams = await Team.countDocuments({
      'currentSupervisor.facultyId': { $in: allFacultyIds }
    });

    res.json({
      success: true,
      statistics: {
        totalBoards,
        totalFacultyAssignments,
        totalTeams,
        averageFacultyPerBoard: totalBoards > 0 ? (totalFacultyAssignments / totalBoards).toFixed(1) : 0
      }
    });

  } catch (error) {
    console.error('Get board statistics error:', error);
    res.status(500).json({ message: 'Server error while fetching board statistics' });
  }
});


app.get('/api/faculty/my-boards', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'faculty') {
      return res.status(403).json({ message: 'Access denied: Faculty only' });
    }

    const boards = await Board.find({
      'faculty._id': req.user.id,
      isActive: true
    }).lean();

    // Enhance boards with evaluation statistics
    const boardsWithStats = await Promise.all(
      boards.map(async (board) => {
        // Count total evaluations and pending evaluations
        const totalEvaluations = await BoardEvaluation.countDocuments({
          boardId: board._id
        });
        
        const pendingEvaluations = await BoardEvaluation.countDocuments({
          boardId: board._id,
          'evaluations': {
            $not: {
              $elemMatch: {
                facultyId: req.user.id,
                isSubmitted: true
              }
            }
          }
        });

        // Find faculty member info in this board
        const facultyMember = board.faculty.find(f => f._id.toString() === req.user.id);

        return {
          ...board,
          totalEvaluations,
          pendingEvaluations,
          facultyRole: facultyMember?.role || 'Member',
          assignedDate: facultyMember?.assignedDate
        };
      })
    );

    res.json({
      success: true,
      boards: boardsWithStats,
      totalBoards: boardsWithStats.length
    });

  } catch (error) {
    console.error('Get faculty boards error:', error);
    res.status(500).json({ message: 'Server error while fetching boards' });
  }
});

// Get teams for evaluation by board and phase
app.get('/api/faculty/boards/:boardId/teams/:phase', authenticate, async (req, res) => {
  try {
    const { boardId, phase } = req.params;
    
    if (req.user.role !== 'faculty') {
      return res.status(403).json({ message: 'Access denied: Faculty only' });
    }

    // Verify faculty is member of this board
    const board = await Board.findOne({
      _id: boardId,
      'faculty._id': req.user.id,
      isActive: true
    });

    if (!board) {
      return res.status(403).json({ message: 'You are not a member of this board' });
    }

    // Get teams in the specified phase that need evaluation
    // For now, get all teams supervised by board faculty in the specified phase
    const boardFacultyIds = board.faculty.map(f => f._id);
    
    const teams = await Team.find({
      currentPhase: phase,
      'currentSupervisor.facultyId': { $in: boardFacultyIds }
    }).lean();

    // Get detailed team member information
    const teamsWithDetails = await Promise.all(
      teams.map(async (team) => {
        const memberStudentIds = team.members.map(member => member.studentId);
        const studentsWithDetails = await Student.find({
          studentId: { $in: memberStudentIds }
        }).select('studentId name email program avatar');

        const studentDetailsMap = new Map(
          studentsWithDetails.map(student => [student.studentId, student])
        );

        const enhancedMembers = team.members.map(member => {
          const studentDetails = studentDetailsMap.get(member.studentId);
          return {
            ...member,
            email: studentDetails?.email || 'Not available',
            program: studentDetails?.program || 'Not specified',
            avatar: studentDetails?.avatar || null
          };
        });

        // Check if this faculty has already evaluated this team
        const existingEvaluation = await BoardEvaluation.findOne({
          boardId: boardId,
          teamId: team._id,
          phase: phase,
          'evaluations.facultyId': req.user.id,
          'evaluations.isSubmitted': true
        });

        // Check if faculty is supervisor of this team
        const isSupervisor = team.currentSupervisor?.facultyId?.toString() === req.user.id;

        return {
          ...team,
          members: enhancedMembers,
          evaluationStatus: existingEvaluation ? 'completed' : 'pending',
          isSupervisor: isSupervisor,
          existingEvaluation: existingEvaluation ? 
            existingEvaluation.evaluations.find(eval => 
              eval.facultyId.toString() === req.user.id
            ) : null
        };
      })
    );

    res.json({
      success: true,
      board: {
        _id: board._id,
        name: board.name,
        description: board.description
      },
      teams: teamsWithDetails,
      phase: phase,
      facultyRole: board.faculty.find(f => f._id.toString() === req.user.id)?.role || 'Member'
    });

  } catch (error) {
    console.error('Get board teams error:', error);
    res.status(500).json({ message: 'Server error while fetching teams' });
  }
});


app.post('/api/faculty/boards/:boardId/teams/:teamId/evaluate', authenticate, async (req, res) => {
  try {
    const { boardId, teamId } = req.params;
    const { 
      phase, 
      evaluationType, 
      teamMark, 
      teamFeedback, 
      individualMarks 
    } = req.body;

    if (req.user.role !== 'faculty') {
      return res.status(403).json({ message: 'Access denied: Faculty only' });
    }

    // Verify faculty is member of this board
    const board = await Board.findById(boardId);
    const facultyMember = board.faculty.find(f => f._id.toString() === req.user.id);
    
    if (!facultyMember) {
      return res.status(403).json({ message: 'You are not a member of this board' });
    }

    const team = await Team.findById(teamId);
    if (!team) {
      return res.status(404).json({ message: 'Team not found' });
    }

    const faculty = await Faculty.findById(req.user.id);
    
    // Check if faculty is supervisor of this team
    const isSupervisor = team.currentSupervisor?.facultyId?.toString() === req.user.id;

    // Validation
    if (evaluationType === 'team') {
      if (!teamMark || teamMark < 0 || teamMark > 100) {
        return res.status(400).json({ message: 'Valid team mark (0-100) is required' });
      }
    } else if (evaluationType === 'individual') {
      if (!individualMarks || !Array.isArray(individualMarks) || individualMarks.length === 0) {
        return res.status(400).json({ message: 'Individual marks are required' });
      }
      
      // Validate individual marks
      for (const mark of individualMarks) {
        if (!mark.studentId || !mark.studentName || 
            typeof mark.mark !== 'number' || mark.mark < 0 || mark.mark > 100) {
          return res.status(400).json({ 
            message: 'All individual marks must be between 0-100' 
          });
        }
      }
    } else {
      return res.status(400).json({ message: 'Invalid evaluation type' });
    }

    // Find or create board evaluation record
    let boardEvaluation = await BoardEvaluation.findOne({
      boardId,
      teamId,
      phase
    });

    if (!boardEvaluation) {
      boardEvaluation = new BoardEvaluation({
        boardId,
        teamId,
        phase,
        evaluations: [],
        totalEvaluators: board.faculty.length,
        status: 'in_progress' // Add default status
      });
    }

    // Remove existing evaluation from this faculty (if updating)
    boardEvaluation.evaluations = boardEvaluation.evaluations.filter(
      eval => eval.facultyId.toString() !== req.user.id
    );

    // Create new evaluation
    const newEvaluation = {
      facultyId: req.user.id,
      facultyName: faculty.name,
      isSupervisor: isSupervisor,
      evaluationType: evaluationType,
      submittedAt: new Date(),
      isSubmitted: true,
      lastModified: new Date()
    };

    if (evaluationType === 'team') {
      newEvaluation.teamMark = teamMark;
      newEvaluation.teamFeedback = teamFeedback || '';
    } else {
      newEvaluation.individualMarks = individualMarks.map(mark => ({
        studentId: mark.studentId,
        studentName: mark.studentName,
        mark: mark.mark,
        feedback: mark.feedback || ''
      }));
    }

    boardEvaluation.evaluations.push(newEvaluation);
    boardEvaluation.submittedEvaluations = boardEvaluation.evaluations.filter(
      eval => eval.isSubmitted
    ).length;

    // Check if all faculty evaluations are complete
    if (boardEvaluation.submittedEvaluations === boardEvaluation.totalEvaluators) {
      // Calculate faculty results (before admin review)
      boardEvaluation.facultyResults = calculateFinalEvaluationResults(
        boardEvaluation, 
        team.members
      );
      
      // Set status to pending admin review instead of completed
      boardEvaluation.status = 'pending_admin_review';
      boardEvaluation.isCompleted = true;
      boardEvaluation.completedAt = new Date();

      // Create notification for admin
      try {
        const notification = new Notification({
          recipientId: null, // For admin notifications
          recipientType: 'Admin',
          type: 'evaluation_review',
          title: 'Board Evaluation Ready for Review',
          message: `Team "${team.name}" Phase ${phase} evaluation is complete and ready for admin review.`,
          data: {
            teamId: team._id,
            teamName: team.name,
            boardId: boardId,
            phase: phase,
            action: 'evaluation_review_needed'
          },
          read: false
        });
        await notification.save();
      } catch (notifError) {
        console.error('Error creating admin notification:', notifError);
      }
    }

    await boardEvaluation.save();

    res.json({
      success: true,
      message: boardEvaluation.status === 'pending_admin_review' 
        ? 'Evaluation submitted! All faculty evaluations complete. Sent to admin for review.' 
        : 'Evaluation submitted successfully!',
      evaluation: boardEvaluation,
      isCompleted: boardEvaluation.isCompleted,
      facultyEvaluation: newEvaluation,
      status: boardEvaluation.status || 'in_progress',
      facultyResults: boardEvaluation.facultyResults // Include faculty results for admin review
    });

  } catch (error) {
    console.error('Submit evaluation error:', error);
    res.status(500).json({ message: 'Server error while submitting evaluation' });
  }
});



app.get('/api/faculty/boards/:boardId/teams/:teamId/evaluation/:phase', authenticate, async (req, res) => {
  try {
    const { boardId, teamId, phase } = req.params;

    if (req.user.role !== 'faculty') {
      return res.status(403).json({ message: 'Access denied: Faculty only' });
    }

    // Verify faculty is member of this board
    const board = await Board.findOne({
      _id: boardId,
      'faculty._id': req.user.id
    });

    if (!board) {
      return res.status(403).json({ message: 'You are not a member of this board' });
    }

    const team = await Team.findById(teamId);
    if (!team) {
      return res.status(404).json({ message: 'Team not found' });
    }

    const boardEvaluation = await BoardEvaluation.findOne({
      boardId,
      teamId,
      phase
    });

    let facultyEvaluation = null;
    if (boardEvaluation) {
      facultyEvaluation = boardEvaluation.evaluations.find(
        eval => eval.facultyId.toString() === req.user.id
      );
    }

    res.json({
      success: true,
      team: team,
      board: board,
      evaluation: boardEvaluation,
      facultyEvaluation: facultyEvaluation,
      hasEvaluated: !!facultyEvaluation?.isSubmitted,
      isSupervisor: team.currentSupervisor?.facultyId?.toString() === req.user.id
    });

  } catch (error) {
    console.error('Get evaluation details error:', error);
    res.status(500).json({ message: 'Server error while fetching evaluation details' });
  }
});
// Submit evaluation
app.post('/api/faculty/boards/:boardId/evaluate', authenticate, async (req, res) => {
  try {
    const { boardId } = req.params;
    const { teamId, phase, evaluationType, teamMark, teamFeedback, individualMarks } = req.body;

    if (req.user.role !== 'faculty') {
      return res.status(403).json({ message: 'Access denied: Faculty only' });
    }

    // Verify faculty is member of this board
    const board = await Board.findById(boardId);
    const facultyMember = board.faculty.find(f => f._id.toString() === req.user.id);
    
    if (!facultyMember) {
      return res.status(403).json({ message: 'You are not a member of this board' });
    }

    const faculty = await Faculty.findById(req.user.id);

    // Find or create board evaluation record
    let boardEvaluation = await BoardEvaluation.findOne({
      boardId,
      teamId,
      phase
    });

    if (!boardEvaluation) {
      boardEvaluation = new BoardEvaluation({
        boardId,
        teamId,
        phase,
        evaluations: []
      });
    }

    // Remove existing evaluation from this faculty
    boardEvaluation.evaluations = boardEvaluation.evaluations.filter(
      eval => eval.facultyId.toString() !== req.user.id
    );

    // Add new evaluation
    const newEvaluation = {
      facultyId: req.user.id,
      facultyName: faculty.name,
      evaluationType,
      submittedAt: new Date(),
      isSubmitted: true
    };

    if (evaluationType === 'team') {
      newEvaluation.teamMark = teamMark;
      newEvaluation.teamFeedback = teamFeedback;
    } else {
      newEvaluation.individualMarks = individualMarks;
    }

    boardEvaluation.evaluations.push(newEvaluation);

    // Calculate final results if all evaluations are complete
    const totalFaculty = board.faculty.length;
    const submittedEvaluations = boardEvaluation.evaluations.length;

    if (submittedEvaluations === totalFaculty) {
      boardEvaluation.finalResults = calculateFinalResults(boardEvaluation);
      boardEvaluation.isCompleted = true;
      boardEvaluation.completedAt = new Date();
    }

    await boardEvaluation.save();

    res.json({
      success: true,
      message: 'Evaluation submitted successfully',
      evaluation: boardEvaluation,
      isCompleted: boardEvaluation.isCompleted
    });

  } catch (error) {
    console.error('Submit evaluation error:', error);
    res.status(500).json({ message: 'Server error while submitting evaluation' });
  }
});

// Get detailed evaluation results for supervisor
app.get('/api/faculty/boards/:boardId/teams/:teamId/detailed-evaluation/:phase', authenticate, async (req, res) => {
  try {
    const { boardId, teamId, phase } = req.params;

    if (req.user.role !== 'faculty') {
      return res.status(403).json({ message: 'Access denied: Faculty only' });
    }

    // Get team and verify supervisor
    const team = await Team.findById(teamId);
    if (!team) {
      return res.status(404).json({ message: 'Team not found' });
    }

    // Verify faculty is the supervisor of this team
    if (!team.currentSupervisor || team.currentSupervisor.facultyId.toString() !== req.user.id) {
      return res.status(403).json({ message: 'You are not the supervisor of this team' });
    }

    // Get board evaluation
    const boardEvaluation = await BoardEvaluation.findOne({
      boardId,
      teamId,
      phase
    }).populate('boardId', 'name faculty');

    if (!boardEvaluation) {
      return res.status(404).json({ 
        message: 'No evaluation found for this team in the specified phase' 
      });
    }

    // Get detailed student information
    const memberStudentIds = team.members.map(member => member.studentId);
    const studentsWithDetails = await Student.find({
      studentId: { $in: memberStudentIds }
    }).select('studentId name email program avatar');

    const studentDetailsMap = new Map(
      studentsWithDetails.map(student => [student.studentId, student])
    );

    // Enhance team members with student details
    const enhancedMembers = team.members.map(member => {
      const studentDetails = studentDetailsMap.get(member.studentId);
      return {
        ...member,
        email: studentDetails?.email || 'Not available',
        program: studentDetails?.program || 'Not specified',
        avatar: studentDetails?.avatar || null
      };
    });

    // Enhanced evaluations with faculty details
    const evaluationsWithDetails = await Promise.all(
      boardEvaluation.evaluations.map(async (evaluation) => {
        const faculty = await Faculty.findById(evaluation.facultyId).select('name email department');
        
        return {
          ...evaluation.toObject(),
          facultyDetails: {
            name: faculty?.name || evaluation.facultyName,
            email: faculty?.email || 'Not available',
            department: faculty?.department || 'Not specified'
          }
        };
      })
    );

    res.json({
      success: true,
      team: {
        ...team.toObject(),
        members: enhancedMembers
      },
      board: boardEvaluation.boardId,
      evaluation: {
        ...boardEvaluation.toObject(),
        evaluations: evaluationsWithDetails
      },
      phase: phase,
      isCompleted: boardEvaluation.isCompleted,
      totalEvaluators: boardEvaluation.totalEvaluators || 0,
      submittedEvaluations: boardEvaluation.submittedEvaluations || 0,
      finalResults: boardEvaluation.finalResults || null
    });

  } catch (error) {
    console.error('Get detailed evaluation error:', error);
    res.status(500).json({ message: 'Server error while fetching detailed evaluation' });
  }
});

// Get supervisor's teams with evaluation status
app.get('/api/faculty/supervisor-teams-evaluations', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'faculty') {
      return res.status(403).json({ message: 'Access denied: Faculty only' });
    }

    // Get teams where this faculty is the supervisor
    const supervisedTeams = await Team.find({
      'currentSupervisor.facultyId': req.user.id
    }).lean();

    // Get evaluation status for each team
    const teamsWithEvaluations = await Promise.all(
      supervisedTeams.map(async (team) => {
        // Get board evaluations for this team
        const evaluations = await BoardEvaluation.find({
          teamId: team._id
        }).populate('boardId', 'name');

        // Get evaluation status by phase
        const evaluationStatus = {};
        for (const phase of ['A', 'B', 'C']) {
          const phaseEvaluation = evaluations.find(eval => eval.phase === phase);
          evaluationStatus[phase] = {
            exists: !!phaseEvaluation,
            isCompleted: phaseEvaluation?.isCompleted || false,
            submittedEvaluations: phaseEvaluation?.submittedEvaluations || 0,
            totalEvaluators: phaseEvaluation?.totalEvaluators || 0,
            boardId: phaseEvaluation?.boardId?._id || null,
            boardName: phaseEvaluation?.boardId?.name || null
          };
        }

        return {
          ...team,
          evaluationStatus
        };
      })
    );

    res.json({
      success: true,
      teams: teamsWithEvaluations
    });

  } catch (error) {
    console.error('Get supervisor teams evaluations error:', error);
    res.status(500).json({ message: 'Server error while fetching supervisor teams evaluations' });
  }
});



// NEW: Get evaluations pending admin review
app.get('/api/admin/evaluations/pending-review', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }

    const pendingEvaluations = await BoardEvaluation.find({
      status: 'pending_admin_review'
    })
    .populate('boardId', 'name')
    .populate('teamId', 'name members')
    .sort({ completedAt: -1 });

    const evaluationsWithDetails = await Promise.all(
      pendingEvaluations.map(async (evaluation) => {
        const team = await Team.findById(evaluation.teamId);
        return {
          ...evaluation.toObject(),
          teamDetails: team
        };
      })
    );

    res.json({
      success: true,
      evaluations: evaluationsWithDetails
    });

  } catch (error) {
    console.error('Get pending evaluations error:', error);
    res.status(500).json({ message: 'Server error while fetching pending evaluations' });
  }
});

// NEW: Get specific evaluation for admin review
app.get('/api/admin/evaluations/:evaluationId', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }

    const evaluation = await BoardEvaluation.findById(req.params.evaluationId)
      .populate('boardId', 'name faculty')
      .populate('teamId', 'name members');

    if (!evaluation) {
      return res.status(404).json({ message: 'Evaluation not found' });
    }

    res.json({
      success: true,
      evaluation: evaluation
    });

  } catch (error) {
    console.error('Get evaluation details error:', error);
    res.status(500).json({ message: 'Server error while fetching evaluation details' });
  }
});

// NEW: Admin update evaluation grades
app.put('/api/admin/evaluations/:evaluationId/review', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }

    const { 
      modifiedGrades, 
      adminComments, 
      action // 'save_draft' or 'finalize'
    } = req.body;

    const evaluation = await BoardEvaluation.findById(req.params.evaluationId);
    if (!evaluation) {
      return res.status(404).json({ message: 'Evaluation not found' });
    }

    // Update admin review data
    evaluation.adminReview = {
      ...evaluation.adminReview,
      isReviewed: true,
      reviewedBy: req.user.id,
      reviewedAt: new Date(),
      adminComments: adminComments || evaluation.adminReview.adminComments
    };

    // Process modified grades
    if (modifiedGrades && Array.isArray(modifiedGrades)) {
      evaluation.adminReview.modifiedGrades = modifiedGrades.map(grade => ({
        studentId: grade.studentId,
        studentName: grade.studentName,
        originalMark: grade.originalMark,
        modifiedMark: grade.modifiedMark,
        modificationReason: grade.modificationReason,
        modifiedAt: new Date()
      }));
    }

    // Calculate final results with admin modifications
    const finalResults = calculateFinalResultsWithAdminModifications(
      evaluation.facultyResults,
      evaluation.adminReview.modifiedGrades
    );
    evaluation.finalResults = finalResults;

    if (action === 'finalize') {
      evaluation.adminReview.isFinalized = true;
      evaluation.adminReview.finalizedAt = new Date();
      evaluation.status = 'finalized';

      // Send grades to students
      await sendGradesToStudents(evaluation);
    } else {
      evaluation.status = 'admin_reviewed';
    }

    await evaluation.save();

    res.json({
      success: true,
      message: action === 'finalize' 
        ? 'Evaluation finalized and grades sent to students!' 
        : 'Evaluation review saved successfully!',
      evaluation: evaluation
    });

  } catch (error) {
    console.error('Admin review evaluation error:', error);
    res.status(500).json({ message: 'Server error while reviewing evaluation' });
  }
});

// Helper function to calculate final results with admin modifications
function calculateFinalResultsWithAdminModifications(facultyResults, modifiedGrades) {
  if (!facultyResults || !facultyResults.individualResults) {
    return facultyResults;
  }

  const modifiedGradeMap = new Map();
  if (modifiedGrades) {
    modifiedGrades.forEach(grade => {
      modifiedGradeMap.set(grade.studentId, grade);
    });
  }

  const updatedResults = facultyResults.individualResults.map(result => {
    const modification = modifiedGradeMap.get(result.studentId);
    
    if (modification) {
      const gradeInfo = convertToGrade(modification.modifiedMark);
      return {
        ...result,
        finalMark: modification.modifiedMark,
        grade: gradeInfo.letter,
        gpa: gradeInfo.gpa,
        isModified: true,
        modificationReason: modification.modificationReason,
        breakdown: {
          ...result.breakdown,
          adminAdjustment: modification.modifiedMark - modification.originalMark,
          finalCalculation: `Original: ${modification.originalMark}%, Admin Modified: ${modification.modifiedMark}% - ${modification.modificationReason}`
        }
      };
    }
    
    return {
      ...result,
      isModified: false
    };
  });

  // Recalculate team average
  const teamAverage = updatedResults.reduce((sum, result) => sum + result.finalMark, 0) / updatedResults.length;
  const teamGrade = convertToGrade(teamAverage);

  return {
    ...facultyResults,
    teamAverage: parseFloat(teamAverage.toFixed(2)),
    teamGrade: teamGrade.letter,
    teamGPA: teamGrade.gpa,
    individualResults: updatedResults
  };
}

// Helper function to send grades to students
async function sendGradesToStudents(evaluation) {
  try {
    const team = await Team.findById(evaluation.teamId);
    if (!team || !evaluation.finalResults) return;

    // Get all team member student IDs
    const memberStudentIds = team.members.map(member => member.studentId);
    const students = await Student.find({
      studentId: { $in: memberStudentIds }
    });

    // Send notification to each student
    for (const student of students) {
      const studentResult = evaluation.finalResults.individualResults.find(
        result => result.studentId === student.studentId
      );

      if (studentResult) {
        const notification = new Notification({
          recipientId: student._id,
          recipientType: 'Student',
          type: 'grade_released',
          title: 'Final Grade Released',
          message: `Your Phase ${evaluation.phase} evaluation grade has been finalized: ${studentResult.grade} (${studentResult.finalMark}%)`,
          data: {
            teamId: team._id,
            teamName: team.name,
            phase: evaluation.phase,
            finalMark: studentResult.finalMark,
            grade: studentResult.grade,
            gpa: studentResult.gpa,
            isModified: studentResult.isModified || false,
            modificationReason: studentResult.modificationReason || null,
            action: 'grade_finalized'
          },
          read: false
        });
        await notification.save();
      }
    }

    console.log(`✅ Grades sent to ${students.length} students for team ${team.name} Phase ${evaluation.phase}`);
  } catch (error) {
    console.error('Error sending grades to students:', error);
  }
}

// In your server.js, add these missing endpoints:

// Get teams available for evaluation
app.get('/api/admin/teams/for-evaluation', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }

    const teams = await Team.find({
      'currentSupervisor.facultyId': { $exists: true },
      status: 'active'
    }).select('_id name members currentPhase status');

    res.json({
      success: true,
      teams
    });
  } catch (error) {
    console.error('Error fetching teams for evaluation:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Assign teams to board for evaluation
app.post('/api/admin/boards/:boardId/assign-teams', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }

    const { boardId } = req.params;
    const { teamIds, phase } = req.body;

    const board = await Board.findById(boardId);
    if (!board) {
      return res.status(404).json({ message: 'Board not found' });
    }

    // Create board evaluations for each team
    for (const teamId of teamIds) {
      const existingEvaluation = await BoardEvaluation.findOne({
        boardId,
        teamId,
        phase
      });

      if (!existingEvaluation) {
        const newEvaluation = new BoardEvaluation({
          boardId,
          teamId,
          phase,
          evaluations: [],
          totalEvaluators: board.faculty.length,
          status: 'in_progress'
        });
        await newEvaluation.save();
      }
    }

    res.json({
      success: true,
      message: `${teamIds.length} teams assigned to board for Phase ${phase} evaluation`
    });

  } catch (error) {
    console.error('Error assigning teams to board:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get evaluation statistics
app.get('/api/admin/evaluations/stats', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }

    const stats = {
      total: await BoardEvaluation.countDocuments(),
      pending: await BoardEvaluation.countDocuments({ status: 'in_progress' }),
      pendingReview: await BoardEvaluation.countDocuments({ status: 'pending_admin_review' }),
      reviewed: await BoardEvaluation.countDocuments({ status: 'admin_reviewed' }),
      finalized: await BoardEvaluation.countDocuments({ status: 'finalized' })
    };

    res.json({
      success: true,
      stats
    });
  } catch (error) {
    console.error('Error fetching evaluation stats:', error);
    res.status(500).json({ message: 'Server error' });
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
  // Call this on server startup
updateTeamSchema();
cleanupOrphanedSupervisionRequests();
await cleanupOrphanedTeamRequests();
});
