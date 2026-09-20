import { extname } from 'node:path';
import { spawnSync } from 'node:child_process';

export function chunks(text, path, size = 60, overlap = 0, baseLine = 1, extra = {}) {
  if (!Number.isInteger(size) || size < 1 || overlap < 0 || overlap >= size) throw new Error('Invalid chunk size or overlap.');
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const result = [];
  for (let i = 0; i < lines.length; i += size - overlap) {
    const content = lines.slice(i, i + size).join('\n');
    if (content.length > 12000) {
      // Never clip source or invent line locations for a giant/minified line.
      if (size === 1) throw new Error(`Line exceeds 12000 characters: ${path}:${baseLine + i}`);
      result.push(...chunks(content, path, Math.max(1, Math.floor(size / 2)), 0, baseLine + i, extra));
    } else if (content.trim()) result.push({ path, line: baseLine + i, endLine: baseLine + Math.min(i + size, lines.length) - 1, text: content, ...extra });
    if (i + size >= lines.length) break;
  }
  return result;
}

let compiler;
export async function sourceChunks(text, path, { chunkLines } = {}) {
  if (chunkLines) return { chunks: chunks(text, path, chunkLines), parser: 'lines' };
  const ext = extname(path).toLowerCase();
  let ranges, parser, context = '';
  const focused = [];
  const header = text.split(/\r?\n/).slice(0, 8).join('\n').slice(0, 1000);
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'].includes(ext)) {
    compiler ??= (await import('typescript')).default;
    const ts = compiler;
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    if (!source.parseDiagnostics.length) {
      ranges = [];
      context = [header, ...source.statements.filter(n => ts.isImportDeclaration(n) || (ts.isVariableStatement(n) && n.getText(source).length < 300)).map(n => n.getText(source))].join('\n').slice(0, 2000);
      for (const node of source.statements) {
        const name = node.name?.getText(source) || (ts.isVariableStatement(node) ? node.declarationList.declarations.map(d => d.name.getText(source)).join(', ') : undefined);
        const add = (n, symbol) => {
          const pos = n.getFullStart();
          const line = source.getLineAndCharacterOfPosition(pos).line;
          const prefix = text.slice(source.getPositionOfLineAndCharacter(line, 0), pos);
          ranges.push({ start: line + 1 + (prefix.trim() ? 1 : 0), end: source.getLineAndCharacterOfPosition(n.end).line + 1, symbol });
        };
        if (ts.isClassDeclaration(node) && node.members.length) {
          add({ getFullStart: () => node.getFullStart(), end: node.members[0].getFullStart() }, name);
          for (const member of node.members) add(member, `${name || 'class'}.${member.name?.getText(source) || 'constructor'}`);
        } else add(node, name);
      }
      // Object methods often live inside large factory functions. Add focused
      // targets without removing the enclosing chunks or their source coverage.
      const visit = (node, scope = []) => {
        let names = scope;
        if ((ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) && node.name) names = [...scope, node.name.getText(source)];
        if (ts.isMethodDeclaration(node) && ts.isObjectLiteralExpression(node.parent)) {
          focused.push({ start: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
            end: source.getLineAndCharacterOfPosition(node.end).line + 1,
            symbol: [...names, node.name.getText(source)].join('.') });
        }
        ts.forEachChild(node, child => visit(child, names));
      };
      visit(source);
      parser = 'typescript';
    }
  } else if (ext === '.py') {
    const script = `import ast,json,sys
s=sys.stdin.read()
t=ast.parse(s)
r=[]
for n in t.body:
 start=min([n.lineno]+[d.lineno for d in getattr(n,'decorator_list',[])])
 if isinstance(n,ast.ClassDef):
  r.append(dict(start=start,end=n.body[0].lineno-1,symbol=n.name))
  for m in n.body:
   r.append(dict(start=min([m.lineno]+[d.lineno for d in getattr(m,'decorator_list',[])]),end=m.end_lineno,symbol=n.name+'.'+getattr(m,'name','body')))
 else:r.append(dict(start=start,end=n.end_lineno,symbol=getattr(n,'name',None)))
print(json.dumps(r))`;
    const result = spawnSync('python3', ['-I', '-c', script], { input: text, encoding: 'utf8', timeout: 3000, maxBuffer: 2 * 1024 * 1024 });
    if (result.status === 0) { ranges = JSON.parse(result.stdout); parser = 'python'; context = header; }
  }
  if (!ranges?.length) return { chunks: chunks(text, path, 60, 10), parser: 'overlapping-lines' };
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const result = [];
  let next = 1;
  for (const range of ranges) {
    const start = Math.min(range.start, next), end = Math.min(range.end, lines.length);
    if (end < start) continue;
    const content = lines.slice(start - 1, end).join('\n');
    // Keep normal declarations whole; long declarations retain overlapping context.
    result.push(...chunks(content, path, end - start < 160 && content.length <= 12000 ? end - start + 1 : 60, end - start < 160 && content.length <= 12000 ? 0 : 10, start, range.symbol ? { symbol: range.symbol } : {}));
    next = end + 1;
  }
  if (next <= lines.length) result.push(...chunks(lines.slice(next - 1).join('\n'), path, 60, 10, next));
  for (const range of focused) {
    if (result.some(c => c.line === range.start && c.endLine === range.end)) continue;
    const content = lines.slice(range.start - 1, range.end).join('\n');
    const whole = range.end - range.start < 160 && content.length <= 12000;
    result.push(...chunks(content, path, whole ? range.end - range.start + 1 : 60, whole ? 0 : 10, range.start, { symbol: range.symbol }));
  }
  return { chunks: result.map(c => ({ ...c, ...(context ? { context } : {}) })), parser };
}
