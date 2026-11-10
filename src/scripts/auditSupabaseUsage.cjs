const fs = require('fs');
const path = require('path');

const repos = [
  { name: 'Olive-Pizza', root: 'c:\\Users\\RYZEN\\Downloads\\olive-pizza' },
  { name: 'Olivepizza-owner', root: 'c:\\Users\\RYZEN\\Downloads\\olive-pizza-owner' },
  { name: 'olive-pizza-delivery', root: 'c:\\Users\\RYZEN\\Downloads\\olive-pizza-delivery' },
  { name: 'olive-pizza-franchise', root: 'c:\\Users\\RYZEN\\Downloads\\olive-pizza-franchise' },
  { name: 'olive-pizza-restaurant', root: 'c:\\Users\\RYZEN\\Downloads\\Olive Pizza restaurant manager' },
  { name: 'olive-pizza-pos', root: 'c:\\Users\\RYZEN\\Downloads\\olive-pizza-pos' }
];

function searchDir(dir, repoName, results) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === 'build' || entry.name === '.next' || entry.name === '.system_generated') continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        searchDir(fullPath, repoName, results);
      } else if (entry.isFile() && /\.(ts|tsx|js|jsx|json|env|env\.example)$/.test(entry.name)) {
        try {
          const content = fs.readFileSync(fullPath, 'utf8');
          if (content.toLowerCase().includes('supabase')) {
            const lines = content.split('\n');
            const matchingLines = [];
            lines.forEach((line, idx) => {
              if (line.toLowerCase().includes('supabase')) {
                matchingLines.push({ lineNum: idx + 1, text: line.trim() });
              }
            });

            results.push({
              repo: repoName,
              file: path.relative(dir, fullPath),
              fullPath,
              matchingLines: matchingLines.slice(0, 5), // top 5 lines
              totalMatches: matchingLines.length,
              hasCreateClient: content.includes('createClient'),
              hasFrom: content.includes('.from('),
              hasChannel: content.includes('.channel('),
              hasRpc: content.includes('.rpc('),
              hasAuth: content.includes('supabase.auth') || content.includes('supabaseAuth'),
            });
          }
        } catch {}
      }
    }
  } catch {}
}

const results = [];
for (const repo of repos) {
  searchDir(repo.root, repo.name, results);
}

console.log('====================================================');
console.log('SUPABASE AUDIT: Found ' + results.length + ' matching files across all 6 repositories');
console.log('====================================================\n');

results.forEach(r => {
  console.log(`[${r.repo}] ${r.fullPath}`);
  console.log(`   createClient: ${r.hasCreateClient} | .from: ${r.hasFrom} | .channel: ${r.hasChannel} | .auth: ${r.hasAuth}`);
  r.matchingLines.forEach(l => {
    console.log(`     L${l.lineNum}: ${l.text.substring(0, 100)}`);
  });
  console.log('---');
});
