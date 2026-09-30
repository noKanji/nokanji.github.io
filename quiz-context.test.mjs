import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuizEngine, normalizeQuizData, parseReadings } from './quiz-engine.mjs';

const rows=[...'学生大私日見今'].map(kanji=>({id:kanji,kanji,meaning:kanji,active:true,
  onyomi:kanji==='私'?'シ':kanji==='日'?'ニチ、ジツ':'オン、レア',kunyomi:kanji==='私'?'わたし':'クン',
  words:kanji==='私'?'私|わたし|я;私立|しりつ|частный':''}));
const words=[
  {id:'student',japanese:'学生',reading:'がくせい',meaning_ru:'студент',active:true,example_jp:'私は学生です。',example_reading:'わたしはがくせいです。',example_ru:'Я студент.'},
  {id:'university',japanese:'大学',reading:'だいがく',meaning_ru:'университет',active:true},
  {id:'self',japanese:'私',reading:'わたし',meaning_ru:'я',active:true},
  {id:'today',japanese:'今日',reading:'きょう',meaning_ru:'сегодня',active:true},
  {id:'private',japanese:'私立',reading:'しりつ',meaning_ru:'частный',active:false},
  {id:'visit',japanese:'見学',reading:'けんがく',meaning_ru:'экскурсия',active:false}
];

test('reference onyomi is deferred without an active word; jukujikun stays whole',()=>{
  const data=normalizeQuizData(rows,words);
  const self=data.kanji.find(x=>x.form==='私');
  assert.deepEqual(self.onyomi,['シ']);
  assert.deepEqual(self.readingVariants.map(x=>[x.form,x.reading]),[['私','わたし']]);
  assert.equal(data.kanji.find(x=>x.form==='見').readingVariants.length,0);
  assert.ok(data.kanji.find(x=>x.form==='日').readingVariants.some(x=>x.form==='今日'&&x.reading==='きょう'));
  assert.ok(data.kanji.find(x=>x.form==='学').readingVariants.some(x=>x.form==='学生'&&x.reading==='がくせい'));
  assert.deepEqual(parseReadings('—;ー;'),[]);
});

test('feedback examples come from active vocabulary, and refer to the tested word',()=>{
  const engine=createQuizEngine(rows,words,()=>0.31);
  const quiz=engine.generateQuiz(100);
  const q=quiz.find(x=>x.kind==='kanji'&&x.prompt==='学生'&&x.type==='kanji_word_reading');
  assert.ok(q);
  assert.equal(q.answer,'がくせい');
  assert.equal(q.source.meaning,'студент');
  assert.equal(q.feedback.focusWord.exampleRu,'Я студент.');
  assert.ok(!quiz.some(x=>x.answer==='シ'||x.answer==='レア'));
  assert.ok(quiz.every(x=>!(x.feedback.words||[]).some(w=>w.form==='私立')));
});

test('kana-equivalent answers and ambiguous reverse readings cannot be alternatives',()=>{
  const kanji=[...'日火山川手目'].map((kanji,i)=>({id:kanji,kanji,active:true,meaning:`m${i}`}));
  const vocab=[...'日火山川手目'].map((japanese,i)=>({id:`w${i}`,japanese,active:true,meaning_ru:`v${i}`,
    reading:['ひ','ヒ','やま','かわ','て','め'][i]}));
  const quiz=createQuizEngine(kanji,vocab,()=>0.37).generateQuiz(100);
  assert.ok(!quiz.some(q=>q.type.endsWith('_from_reading')&&['ひ','ヒ'].includes(q.prompt)));
  assert.ok(!quiz.some(q=>q.type.endsWith('_reading')&&q.choices.includes('ひ')&&q.choices.includes('ヒ')));
});

test('a bare number uses its active word reading, never the reading of its counter form',()=>{
  const data=normalizeQuizData([{id:'五',kanji:'五',active:true,onyomi:'ゴ',kunyomi:'いつつ'}],
    [{id:'five',japanese:'五',reading:'ご',meaning_ru:'пять',active:true},
      {id:'five-things',japanese:'五つ',reading:'いつつ',meaning_ru:'пять штук',active:true}]);
  assert.deepEqual(data.kanji[0].readingVariants.map(x=>[x.form,x.reading]),[['五','ご'],['五つ','いつつ']]);
});
