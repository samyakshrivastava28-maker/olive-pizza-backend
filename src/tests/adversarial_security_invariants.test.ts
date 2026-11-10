import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { FinancialIdempotencyRepository } from '../repositories/FinancialIdempotencyRepository.ts';
import { InvoiceEngine } from '../services/payment/InvoiceEngine.ts';
import { sanitizeEmailHtml } from '../utils/htmlSanitizer.ts';
import { verifyReportCapabilityToken } from '../routes/report.routes.ts';

describe('POST-COMMIT SECURITY & REMEDIATION ADVERSARIAL SUITE', () => {


  describe('1. Timing-Safe Buffer Comparison Invariants', () => {
    it('Safely rejects mismatched length buffers without throwing RangeError', () => {
      const secret = 'ultra-secure-rpc-secret-32-bytes-length';
      const attackerShortSecret = 'short';
      
      const secretBuf = Buffer.from(secret, 'utf8');
      const attackerBuf = Buffer.from(attackerShortSecret, 'utf8');

      // Validating length check prevents crypto.timingSafeEqual RangeError
      let safeCheckPassed = false;
      if (secretBuf.length === attackerBuf.length) {
        safeCheckPassed = crypto.timingSafeEqual(secretBuf, attackerBuf);
      } else {
        safeCheckPassed = false;
      }
      assert.strictEqual(safeCheckPassed, false, 'Length mismatch must cleanly return false');
    });

    it('Correctly validates identical tokens with timingSafeEqual', () => {
      const secret = 'ultra-secure-rpc-secret-32-bytes-length';
      const tokenBuf = Buffer.from(secret, 'utf8');
      const expectedBuf = Buffer.from(secret, 'utf8');
      
      assert.strictEqual(tokenBuf.length === expectedBuf.length, true);
      assert.strictEqual(crypto.timingSafeEqual(tokenBuf, expectedBuf), true);
    });
  });

  describe('2. Persistent Financial Idempotency Architecture', () => {
    it('Calculates deterministic SHA-256 hash regardless of object key order', () => {
      const payload1 = { orderId: 'ord_123', amount: 599, currency: 'INR', provider: 'razorpay' };
      const payload2 = { currency: 'INR', provider: 'razorpay', orderId: 'ord_123', amount: 599 };

      const hash1 = FinancialIdempotencyRepository.calculateHash(payload1);
      const hash2 = FinancialIdempotencyRepository.calculateHash(payload2);

      assert.strictEqual(hash1, hash2, 'Hash must be identical regardless of key order');
      assert.strictEqual(hash1.length, 64, 'SHA-256 hash must be 64 hex characters');
    });

    it('Detects hash differences for mismatched financial payloads', () => {
      const payloadA = { orderId: 'ord_123', amount: 599, currency: 'INR' };
      const payloadB = { orderId: 'ord_123', amount: 999, currency: 'INR' }; // Tampered amount

      const hashA = FinancialIdempotencyRepository.calculateHash(payloadA);
      const hashB = FinancialIdempotencyRepository.calculateHash(payloadB);

      assert.notStrictEqual(hashA, hashB, 'Hashes must differ for different monetary amounts');
    });
  });

  describe('3. Invoice HTML XSS Neutralization', () => {
    it('Escapes malicious scripts and event handlers in customer details and items', () => {
      const xssInvoice = InvoiceEngine.generateInvoiceHtml({
        orderId: 'ord_test_xss',
        paymentId: 'pay_xss_<script>alert("pwned")</script>',
        customerName: '<img src=x onerror=alert(1)> Hacker Name',
        customerPhone: '<svg onload=alert(2)>',
        customerAddress: '"><script>document.location="http://evil.com"</script>',
        items: [
          {
            name: '<b onmouseover=alert("xss")>Malicious Pizza</b>',
            size: '"><script>',
            quantity: 1,
            price: 299,
          }
        ],
        totalAmount: 299,
        paymentMethod: '<iframe src=javascript:alert(3)>',
        createdAt: new Date().toISOString(),
      });

      // Assert no unescaped script, img onerror, or iframe tags
      assert.strictEqual(xssInvoice.includes('<script>'), false, 'Raw script tags must not exist');
      assert.strictEqual(xssInvoice.includes('onerror='), false, 'Raw onerror handler must not exist');
      assert.strictEqual(xssInvoice.includes('<iframe'), false, 'Raw iframe tags must not exist');
      assert.strictEqual(xssInvoice.includes('&lt;script&gt;'), true, 'Script tags must be escaped as HTML entities');
      assert.strictEqual(xssInvoice.includes('&lt;img'), true, 'Image tags must be escaped as HTML entities');
    });
  });

  describe('4. Email Content Strict Sanitization', () => {
    it('Strips scripts, iframes, and javascript: links while preserving benign markup', () => {
      const maliciousHtml = `
        <div style="color: red;">
          <h1>Welcome!</h1>
          <script>window.__token = localStorage.getItem('token');</script>
          <iframe src="http://attacker.com/steal"></iframe>
          <a href="javascript:alert('xss')">Click here for free pizza!</a>
          <img src="https://olivepizza.app/logo.png" onload="alert('hack')" alt="logo" />
        </div>
      `;

      const cleanHtml = sanitizeEmailHtml(maliciousHtml);

      assert.strictEqual(cleanHtml.includes('<script'), false, 'Scripts must be completely stripped');
      assert.strictEqual(cleanHtml.includes('<iframe'), false, 'Iframes must be completely stripped');
      assert.strictEqual(cleanHtml.includes('javascript:'), false, 'javascript: links must be stripped');
      assert.strictEqual(cleanHtml.includes('onload='), false, 'Event handlers must be stripped');
      assert.strictEqual(cleanHtml.includes('Welcome!'), true, 'Benign content must be preserved');
      assert.strictEqual(cleanHtml.includes('https://olivepizza.app/logo.png'), true, 'Safe images must be preserved');
    });
  });

  describe('5. Report Capability Token Verification', () => {
    it('Rejects malformed, expired, or non-matching capability tokens', () => {
      assert.strictEqual(verifyReportCapabilityToken(''), false);
      assert.strictEqual(verifyReportCapabilityToken('invalid_token_string'), false);
      
      // Expired token simulation
      const pastTime = Math.floor(Date.now() / 1000) - 3600;
      const expiredPayload = `rep_01:reporting:feed:${pastTime}:invalidsig`;
      const expiredToken = Buffer.from(expiredPayload).toString('base64url');
      assert.strictEqual(verifyReportCapabilityToken(expiredToken), false);
    });
  });

  describe('6. CI/CD Workflow & Android Signing Fail-Closed Static Analysis', () => {
    // In olive-pizza-owner/backend, root repo is '..' and sibling repos are '../..'
    const currentRepoRoot = fs.existsSync(path.resolve(process.cwd(), '.gitignore'))
      ? path.resolve(process.cwd())
      : path.resolve(process.cwd(), '..');
    const siblingBaseDir = path.resolve(currentRepoRoot, '..');

    const repoNames = [
      'olive-pizza',
      'olive-pizza-owner',
      'Olive Pizza restaurant manager',
      'olive-pizza-delivery',
      'olive-pizza-pos',
      'olive-pizza-franchise'
    ];
    // Filter to repositories that actually exist in the local workspace or environment
    const repos = repoNames
      .map(name => path.join(siblingBaseDir, name))
      .filter(repoPath => fs.existsSync(repoPath) && fs.existsSync(path.join(repoPath, 'android', 'app')));

    // If running in isolated CI, test current repository if it has android/app
    if (repos.length === 0 && fs.existsSync(path.join(currentRepoRoot, 'android', 'app'))) {
      repos.push(currentRepoRoot);
    }

    it('Verifies NO repository has tracked release.keystore in git or on disk in android/app', () => {
      for (const repo of repos) {
        const keystorePath = path.join(repo, 'android', 'app', 'release.keystore');
        assert.strictEqual(fs.existsSync(keystorePath), false, `Keystore must not exist on disk: ${keystorePath}`);

        const gitignoreContent = fs.readFileSync(path.join(repo, '.gitignore'), 'utf8');
        assert.strictEqual(gitignoreContent.includes('release.keystore'), true, `.gitignore in ${repo} must ignore release.keystore`);
      }
    });

    it('Verifies android/app/build.gradle contains NO fallback passwords ("olivepizza")', () => {
      for (const repo of repos) {
        const gradlePath = path.join(repo, 'android', 'app', 'build.gradle');
        const gradleContent = fs.readFileSync(gradlePath, 'utf8');
        assert.strictEqual(gradleContent.includes('?: "olivepizza"'), false, `build.gradle in ${repo} must not have fallback password`);
        assert.strictEqual(gradleContent.includes('GradleException'), true, `build.gradle in ${repo} must throw GradleException on missing secrets`);
      }
    });

    it('Verifies GitHub Actions Android workflows contain release concurrency and NO unescaped single quotes', () => {
      for (const repo of repos) {
        const workflowPath = path.join(repo, '.github', 'workflows', 'build-android.yml');
        const workflowContent = fs.readFileSync(workflowPath, 'utf8');
        assert.strictEqual(workflowContent.includes("|| 'olivepizza'"), false, `Workflow in ${repo} must not have fallback quote bug`);
        assert.strictEqual(workflowContent.includes('concurrency:'), true, `Workflow in ${repo} must have concurrency group`);
      }
    });
  });
});
