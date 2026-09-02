const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const TurndownService = require('turndown');
const turndownPluginGfm = require('turndown-plugin-gfm');

const turndownService = new TurndownService({ headingStyle: 'atx' });
turndownService.use(turndownPluginGfm.tables); // enable tables

let allQuestions = [];
let qIdCounter = 1;

function cleanA(text) {
    let result = text;
    result = result.replace(/^from perplexity\s*\n*/i, ''); // Strip perplexity prefix
    result = result.replace(/(\s*\[[^\]]+\])+$/g, ''); // end of text
    result = result.replace(/\\\[\[[^\]]+\]\([^)]+\)\\\]/g, ''); // escaped brackets \[[text](url)\]
    result = result.replace(/\[\[[^\]]+\]\([^)]+\)\]/g, ''); // normal brackets [[text](url)]
    result = result.replace(/\s*\[[^\]]+\](?!\()/g, ''); // unlinked sources like [bn.wikipedia]
    return result.trim();
}
function cleanQ(text) {
    let q = text.replace(/^[\(]?.\)[\)]?\s*/, '').trim(); 
    q = q.replace(/^[০-৯ক-ক্ষ]+\s*[\.\)]\s*/, '').trim();
    return q;
}

function processDirectory(dirPath, examType) {
  if (!fs.existsSync(dirPath)) return;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const mainFiles = entries.filter(e => !e.isDirectory() && e.name.endsWith('.html'));
  
  for (const file of mainFiles) {
    const mainFilePath = path.join(dirPath, file.name);
    let subjectId = '';
    if (file.name.includes('দক্ষিণ এশিয়ার সরকার ও রাজনীতি')) {
        subjectId = '231905';
    } else {
        const m = file.name.match(/\((.*?)\)/);
        if (!m) continue;
        const rawId = m[1].trim();
        const bngToEng = {'০':'0','১':'1','২':'2','৩':'3','৪':'4','৫':'5','৬':'6','৭':'7','৮':'8','৯':'9'};
        subjectId = rawId.replace(/[০-৯]/g, v => bngToEng[v] || v);
    }
    
    let baseName = file.name.replace(/\s+[a-f0-9]{32}\.html$/, '');
    if (baseName === file.name) {
        baseName = file.name.replace(/\.html$/, '');
    }
    
    const subjectDir = path.join(dirPath, baseName);
    console.log(`Processing subject: ${subjectId} in ${examType}`);
    processSubject(mainFilePath, subjectDir, examType, subjectId);
  }
}

function processSubject(mainFilePath, subjectDir, examType, subjectId) {
  const htmlContent = fs.readFileSync(mainFilePath, 'utf-8');
  const dom = new JSDOM(htmlContent);
  const document = dom.window.document;
  
  const pageBody = document.querySelector('.page-body');
  if (!pageBody) return;
  
  let currentSection = null;
  let q = '';
  let a = '';
  
  for (const child of pageBody.children) {
    if (child.tagName === 'BLOCKQUOTE') {
      if (q && a && currentSection === 'ka') {
          allQuestions.push({
              id: `q${qIdCounter++}`,
              examType,
              subjectId,
              section: currentSection,
              q: cleanQ(q),
              a: cleanA(a)
          });
          q = '';
          a = '';
      }
      const text = child.textContent.trim().replace(/-/g, ' ').replace(/\s+/g, ' ');
      if (text.includes('ক বিভাগ')) currentSection = 'ka';
      else if (text.includes('খ বিভাগ')) currentSection = 'kha';
      else if (text.includes('গ বিভাগ')) currentSection = 'ga';
      else currentSection = null;
    } else if (currentSection === 'ka') {
      let rawHtml = '';
      if (child.tagName === 'UL') {
          rawHtml = '<ul>' + child.innerHTML + '</ul>';
      } else {
          rawHtml = child.innerHTML;
      }
      if (!rawHtml) continue;

      const isHeading = ['H1', 'H2', 'H3', 'H4'].includes(child.tagName);
      const hasBr = rawHtml.includes('<br');
      
      const parts = hasBr ? rawHtml.split(/<br\s*\/?>/i) : [rawHtml];
      
      for (const part of parts) {
          const text = new JSDOM(part).window.document.body.textContent.trim();
          if (!text) continue;
          
          const isQuestionMarker = text.match(/^[ক-ল০-৯0-9]+[\.\)]/) || isHeading;
          const isAnswerMarker = text.match(/^(উত্তর|উঃ)/) || text.includes('উত্তরঃ');
          
          if (isQuestionMarker && !isAnswerMarker) {
              if (q && a) {
                  allQuestions.push({
                      id: `q${qIdCounter++}`,
                      examType,
                      subjectId,
                      section: currentSection,
                      q: cleanQ(q),
                      a: cleanA(a)
                  });
              }
              q = text;
              a = '';
          } else if (isAnswerMarker) {
              const cleanedText = text.replace(/^(উত্তর|উঃ)\s*:?\s*/, '').trim();
              if (a) {
                  a += (cleanedText ? '\n\n' + cleanedText : '');
              } else {
                  a = cleanedText;
              }
          } else {
              // No clear marker. If we have a 'q' but no 'a', and it's the first answer part, it belongs to 'a'.
              // If we already have 'a', append to 'a'.
              if (q) {
                  if (a) {
                      a += '\n\n' + text;
                  } else {
                      a = text;
                  }
              } else {
                  // Fallback: treat as question if q is empty
                  q = text;
              }
          }
      }
    } else if (child.tagName === 'FIGURE' && child.classList.contains('link-to-page') && (currentSection === 'kha' || currentSection === 'ga')) {
      const aTag = child.querySelector('a');
      if (aTag) {
        let qText = aTag.textContent.trim();
        const href = aTag.getAttribute('href');
        const targetFilename = decodeURIComponent(href.split('/').pop());
        const targetPath = path.join(subjectDir, targetFilename);
        
        let aMarkdown = '';
        if (fs.existsSync(targetPath)) {
            const linkedContent = fs.readFileSync(targetPath, 'utf-8');
            const linkedDom = new JSDOM(linkedContent);
            const linkedBody = linkedDom.window.document.querySelector('.page-body');
            if (linkedBody) {
                aMarkdown = turndownService.turndown(linkedBody.innerHTML);
            }
        }
        
        allQuestions.push({
            id: `q${qIdCounter++}`,
            examType,
            subjectId,
            section: currentSection,
            q: cleanQ(qText),
            a: cleanA(aMarkdown)
        });
      }
    }
  }
}

// 1. Process old directories
const oldRoot = 'D:\\MyAllProjects\\NewWebsite\\Private & Shared\\Hons Third Year';
const examMap = {
  'Third Year 1st Incourse': 'incourse1',
  'Third Year 2nd Incourse': 'incourse2',
  'Third Year Test Exam': 'test'
};
for (const [folder, examType] of Object.entries(examMap)) {
  const p = path.join(oldRoot, folder);
  processDirectory(p, examType);
}

// 2. Remove any test exam 231903 questions extracted from old folder (we want the updated one)
allQuestions = allQuestions.filter(q => !(q.examType === 'test' && (q.subjectId === '231903' || q.subjectId === '231905' || q.subjectId === '231907' || q.subjectId === '231909')));

// 3. Process new updated test exam directory
const newDir = 'D:\\MyAllProjects\\NewWebsite\\New folder\\Private & Shared';
processDirectory(newDir, 'test');

// 3.5 Process second updated test exam directory (231905)
const newDir2 = 'D:\\MyAllProjects\\NewWebsite\\New folder (2)\\Private & Shared';
processDirectory(newDir2, 'test');

// 3.6 Process third updated test exam directory (231907)
const newDir3 = 'D:\\MyAllProjects\\NewWebsite\\New folder (3)\\Private & Shared';
processDirectory(newDir3, 'test');

// 3.7 Process fourth updated test exam directory (231909)
const newDir4 = 'D:\\MyAllProjects\\NewWebsite\\New folder (4)\\Private & Shared';
processDirectory(newDir4, 'test');

// Apply manual fixes before saving
const p5Question = allQuestions.find(q => q.examType === 'test' && q.subjectId === '231903' && q.q.includes('জাতিসংঘের পঞ্চশক্তি কারা'));
if (p5Question) {
    p5Question.a = 'জাতিসংঘের নিরাপত্তা পরিষদের স্থায়ী পাঁচ সদস্য (P5): যুক্তরাষ্ট্র, যুক্তরাজ্য, ফ্রান্স, রাশিয়া, এবং চীন।';
}

// 4. Update index.html
const indexPath = 'D:\\MyAllProjects\\political-science-hons\\index.html';
let indexContent = fs.readFileSync(indexPath, 'utf-8');

// Replace questions
const regex = /const allQuestions = \[\s*[\s\S]*?\s*\];/;
const replacement = `const allQuestions = ${JSON.stringify(allQuestions, null, 12)};`;
indexContent = indexContent.replace(regex, replacement);

// Fix CSS
const oldCss = `  #single-answer-view .answer-content{
    text-align:left;
    line-height:1.6;
    font-size:15px;
    padding:0 4px;
    white-space:pre-wrap;
  }`;

const newCss = `  #single-answer-view .answer-content{
    text-align:left;
    line-height:1.6;
    font-size:15px;
    padding:0 4px;
  }
  .answer-content p {
    margin-bottom: 12px;
  }
  .answer-content h1, .answer-content h2, .answer-content h3 {
    margin-top: 20px;
    margin-bottom: 12px;
    font-weight: 700;
    color: var(--gold);
  }
  .answer-content strong, .answer-content b {
    font-weight: 600;
    color: var(--gold);
  }
  .answer-content table {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 16px;
    font-size: 14px;
  }
  .answer-content th, .answer-content td {
    border: 1px solid var(--line);
    padding: 10px;
    text-align: left;
  }
  .answer-content th {
    background-color: var(--bg-deep);
    font-weight: 600;
    color: var(--gold);
  }
  .answer-content ul, .answer-content ol {
    margin-bottom: 12px;
    padding-left: 20px;
  }
  .answer-content li {
    margin-bottom: 6px;
  }`;

if (indexContent.includes('white-space:pre-wrap;')) {
    indexContent = indexContent.replace(oldCss, newCss);
}

fs.writeFileSync(indexPath, indexContent);
console.log(`Rebuilt everything! Total questions: ${allQuestions.length}`);
