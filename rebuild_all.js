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
    let result = text.replace(/(s*\[[^\]]+\])+$/g, ''); // end of text
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
      const text = child.textContent.trim().replace(/-/g, ' ');
      if (text.includes('ক বিভাগ')) currentSection = 'ka';
      else if (text.includes('খ বিভাগ')) currentSection = 'kha';
      else if (text.includes('গ বিভাগ')) currentSection = 'ga';
      else currentSection = null;
    } else if (currentSection === 'ka') {
      if (child.tagName === 'H2' || child.tagName === 'H3' || child.tagName === 'H4') {
          // If we already had a pending question, push it before starting a new one
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
          q = child.textContent.trim();
          a = '';
      } else if (child.tagName === 'P' || child.tagName === 'UL') {
          let rawHtml = '';
          if (child.tagName === 'UL') {
              rawHtml = '<ul>' + child.innerHTML + '</ul>';
          } else {
              rawHtml = child.innerHTML;
          }
          
          if (!rawHtml) continue;

          // Legacy format support: if Q and A are in the same P tag separated by <br>
          if (rawHtml.includes('<br') && !q) {
              const parts = rawHtml.split(/<br\s*\/?>/i);
              let localQ = '';
              let localA = '';
              for (const part of parts) {
                  const text = new JSDOM(part).window.document.body.textContent.trim();
                  if (!text) continue;
                  
                  if (text.match(/^(উত্তর|উঃ)/) || text.includes('উত্তরঃ')) {
                      localA = text.replace(/^(উত্তর|উঃ)\s*:?\s*/, '').trim();
                      if (localQ && localA) {
                          allQuestions.push({
                              id: `q${qIdCounter++}`,
                              examType,
                              subjectId,
                              section: currentSection,
                              q: cleanQ(localQ),
                              a: cleanA(localA)
                          });
                          localQ = '';
                          localA = '';
                      }
                  } else {
                      localQ = text;
                  }
              }
          } else {
              // New format: Q is H2, A is subsequent P/UL tags
              const text = new JSDOM(rawHtml).window.document.body.textContent.trim();
              if (text) {
                  let cleanedText = text;
                  if (cleanedText.match(/^(উত্তর|উঃ)/) || cleanedText.includes('উত্তরঃ')) {
                      cleanedText = cleanedText.replace(/^(উত্তর|উঃ)\s*:?\s*/, '').trim();
                  }
                  
                  if (a) {
                      a += '\n\n' + cleanedText;
                  } else {
                      a = cleanedText;
                  }
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
allQuestions = allQuestions.filter(q => !(q.examType === 'test' && (q.subjectId === '231903' || q.subjectId === '231905')));

// 3. Process new updated test exam directory
const newDir = 'D:\\MyAllProjects\\NewWebsite\\New folder\\Private & Shared';
processDirectory(newDir, 'test');

// 3.5 Process second updated test exam directory (231905)
const newDir2 = 'D:\\MyAllProjects\\NewWebsite\\New folder (2)\\Private & Shared';
processDirectory(newDir2, 'test');

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
