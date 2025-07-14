// Always load .env.local first (if present), then .env for fallback
const dotenv = require('dotenv');
const path = require('path');

// Try to load .env.local first
const envLocalPath = path.resolve(process.cwd(), '.env.local');
const envPath = path.resolve(process.cwd(), '.env');

// Load .env.local if it exists
const localResult = dotenv.config({ path: envLocalPath });
if (localResult.error) {
  // If .env.local not found, fallback to .env
  dotenv.config({ path: envPath });
}

const fetch = require("node-fetch");


// ============================================================================
// CLOUD SERVICES
// ============================================================================

/**
 * AWS services (singletons)
 * S3, SES, DynamoDB clients
 */
const AWS = require('aws-sdk');

// Configure AWS using environment variables
AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});

const dynamoDB = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();
const ses = new AWS.SES({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION || 'us-west-1', // SES region, fallback to us-west-1
});


/**
 * Upload a file from URL to S3
 * @param {string} url - URL to fetch the file from
 * @param {string} filename - S3 key/filename to store as
 * @returns {string} S3 URL of uploaded file or empty string on error
 */
async function uploadFileToS3(url, filename) {
  try {
    console.log("uploadFileToS3() - fetching: " + url);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const fileBuffer = await response.arrayBuffer();

    // Determine the content type based on the file extension
    var contentType;
    if (filename.endsWith(".jpg") || filename.endsWith(".jpeg")) {
      contentType = "image/jpeg";
    } else if (filename.endsWith(".png")) {
      contentType = "image/png";
    } else if (filename.endsWith(".epub")) {
      contentType = "application/epub+zip";
    } else if (filename.endsWith(".mp3")) {
      contentType = "audio/mpeg";
    } else {
      contentType = "application/octet-stream"; // Default content type
    }
    
    const params = {
      Bucket: "sobrief",
      Key: filename,
      Body: Buffer.from(fileBuffer),
      ContentType: contentType,
    };
    
    console.log("uploadFileToS3() - uploading: " + filename);
    const uploadResult = await s3.upload(params).promise();
    var file_url = uploadResult.Location;
    console.log("uploadFileToS3() - done: " + file_url);

    return file_url;
  } catch (error) {
    console.error("Error uploading file:", error);
    return "";
  }
}

const fs = require('fs');
// Remove duplicate require('path')
// const path = require('path'); // <-- REMOVE THIS LINE

// Helper to determine content type based on file extension
function getContentType(filename) {
  if (filename.endsWith('.jpg') || filename.endsWith('.jpeg')) {
    return 'image/jpeg';
  } else if (filename.endsWith('.png')) {
    return 'image/png';
  } else if (filename.endsWith('.epub')) {
    return 'application/epub+zip';
  } else if (filename.endsWith('.mp3')) {
    return 'audio/mpeg';
  } else if (filename.endsWith('.json')) {
    return 'application/json';
  } else {
    return 'application/octet-stream';
  }
}

async function uploadLocalFileToS3(localFilePath, s3Key) {
  const fileBuffer = fs.readFileSync(localFilePath);
  const contentType = getContentType(s3Key);
  const params = {
    Bucket: "sobrief",
    Key: s3Key,
    Body: fileBuffer,
    ContentType: contentType,
  };
  const uploadResult = await s3.upload(params).promise();
  return uploadResult.Location;
}

// Export the functions
module.exports = {
  uploadFileToS3,
  uploadLocalFileToS3
};

if (require.main === module) {
//   uploadFileToS3(
//     "https://sobrief.s3.us-west-1.amazonaws.com/immersive-audio/4fbb4a7d-e2e3-41b6-bb43-74d19d04cdbe-audio.mp3",
//     "immersive-audio/4fbb4a7d-e2e3-41b6-bb43-74d19d04cdbe-audio.mp3"
//   ).then(console.log);
  uploadLocalFileToS3(
    "4fbb4a7d-e2e3-41b6-bb43-74d19d04cdbe-audio.mp3",
    "immersive-audio/4fbb4a7d-e2e3-41b6-bb43-74d19d04cdbe-audio.mp3"
  ).then(console.log);
}