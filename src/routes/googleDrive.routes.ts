import express from 'express';
import { googleDriveService } from '../services/googleDrive.service.js';

const router = express.Router();

router.get('/health', async (req, res) => {
  if (!googleDriveService.isEnabled) {
    return res.status(503).json({
      status: 'disabled',
      message: 'Google Drive integration is currently disabled'
    });
  }

  const status = await googleDriveService.getHealthStatus();
  
  if (!status.connected) {
    return res.status(500).json({
      status: 'error',
      message: 'Authentication Failure',
      error: 'See server logs for details'
    });
  }

  // Upload Test
  let uploadTestPassed = false;
  let testFileId: string | null = null;
  
  try {
    const testBuffer = Buffer.from('Integration test file content', 'utf8');
    testFileId = await googleDriveService.uploadBuffer('health-test.txt', testBuffer, 'text/plain');
    if (testFileId) {
      uploadTestPassed = true;
      // Immediately delete
      await googleDriveService.deleteFile(testFileId);
    }
  } catch (error) {
    console.error('[Google Drive] Upload test failed during health check');
  }

  res.json({
    status: 'ok',
    diagnostics: {
      Connected: true,
      Authenticated: true,
      User: status.user,
      FolderConfigured: status.folderConfigured,
      FolderAccessible: status.folderAccessible,
      UploadTestPassed: uploadTestPassed
    }
  });
});

export default router;
