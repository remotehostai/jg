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
        const add = (n, symbol, declaration) => {
          const pos = n.getFullStart();
          const line = source.getLineAndCharacterOfPosition(pos).line;
          const prefix = text.slice(source.getPositionOfLineAndCharacter(line, 0), pos);
          ranges.push({ start: line + 1 + (prefix.trim() ? 1 : 0), end: source.getLineAndCharacterOfPosition(n.end).line + 1, symbol, declaration });
        };
        if (ts.isClassDeclaration(node) && node.members.length) {
          add({ getFullStart: () => node.getFullStart(), end: node.members[0].getFullStart() }, name);
          for (const member of node.members) add(member, `${name || 'class'}.${member.name?.getText(source) || 'constructor'}`, member);
        } else add(node, name, node);
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
      // A long function is several behaviours in one range: a request router
      // holds a guard per route, a loop body holds its own error handling.
      // Judged whole, such a range scores vaguely for everything it touches and
      // quoting it cannot show which branch answered. Split it into the blocks
      // inside it instead. The split covers every original line, so the
      // declaration is replaced rather than sampled and coverage is unchanged.
      const lineOf = position => source.getLineAndCharacterOfPosition(position).line + 1;
      const bodyBlock = node => {
        if (ts.isBlock(node)) return node;
        if (node.body && ts.isBlock(node.body)) return node.body;
        if (ts.isVariableStatement(node)) for (const d of node.declarationList.declarations) { const block = d.initializer && bodyBlock(d.initializer); if (block) return block; }
        if (ts.isExpressionStatement(node)) return bodyBlock(node.expression);
        if (ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node) || ts.isReturnStatement(node)) return node.expression && bodyBlock(node.expression);
        if (ts.isPropertyAccessExpression(node)) return bodyBlock(node.expression);
        if (ts.isCallExpression(node)) for (const argument of node.arguments) { const block = bodyBlock(argument); if (block) return block; }
        if (ts.isIfStatement(node) && node.thenStatement) return bodyBlock(node.thenStatement);
        if (ts.isTryStatement(node)) return node.tryBlock;
        if ((ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isWhileStatement(node)) && node.statement) return bodyBlock(node.statement);
        return undefined;
      };
      const partition = (node, start, end, symbol, depth = 0) => {
        const block = node && bodyBlock(node);
        const statements = block?.statements.filter(s => s.getStart(source) < s.end) || [];
        if (end - start < 24 || !statements.length) return undefined;
        // A body that only wraps one statement (a loop, a Promise.all worker)
        // carries no split of its own; look inside it for one.
        if (statements.length === 1) return depth < 3 ? partition(statements[0], start, end, symbol, depth + 1) : undefined;
        const parts = [];
        let cursor = start, group = [];
        const flush = last => {
          if (!group.length) return;
          const stop = last ? end : Math.min(end, lineOf(group.at(-1).end));
          if (stop >= cursor) {
            const inner = group.length === 1 && depth < 3 ? partition(group[0], cursor, stop, symbol, depth + 1) : undefined;
            if (inner) parts.push(...inner); else parts.push({ start: cursor, end: stop, symbol });
            cursor = stop + 1;
          }
          group = [];
        };
        for (const statement of statements) {
          const span = lineOf(statement.end) - lineOf(statement.getStart(source)) + 1;
          if (group.length && (span >= 6 || lineOf(statement.end) - cursor + 1 > 20)) flush(false);
          group.push(statement);
          if (span >= 6 && statement !== statements.at(-1)) flush(false);
        }
        flush(true);
        return parts.length > 1 ? parts : undefined;
      };
      ranges = ranges.flatMap(range => partition(range.declaration, range.start, range.end, range.symbol) || [range]);
      parser = 'typescript';
    }
  } else if (ext === '.py') {
    // Same split as the TypeScript parser: a long body becomes the blocks
    // inside it, covering every line of the original range.
    const script = `import ast,json,sys
s=sys.stdin.read()
t=ast.parse(s)
r=[]
def begin(n):return min([n.lineno]+[d.lineno for d in getattr(n,'decorator_list',[])])
def parts(node,start,end,symbol,depth=0):
 body=getattr(node,'body',None)
 if not isinstance(body,list) or end-start<24:return None
 stmts=[x for x in body if hasattr(x,'lineno') and hasattr(x,'end_lineno')]
 if not stmts:return None
 if len(stmts)==1:return parts(stmts[0],start,end,symbol,depth+1) if depth<3 else None
 out=[];cursor=start;group=[]
 def flush(last):
  nonlocal cursor,group
  if not group:return
  stop=end if last else min(end,group[-1].end_lineno)
  if stop>=cursor:
   inner=parts(group[0],cursor,stop,symbol,depth+1) if len(group)==1 and depth<3 else None
   out.extend(inner) if inner else out.append(dict(start=cursor,end=stop,symbol=symbol))
   cursor=stop+1
  group.clear()
 for x in stmts:
  span=x.end_lineno-begin(x)+1
  if group and (span>=6 or x.end_lineno-cursor+1>20):flush(False)
  group.append(x)
  if span>=6 and x is not stmts[-1]:flush(False)
 flush(True)
 return out if len(out)>1 else None
def emit(node,start,end,symbol):
 p=parts(node,start,end,symbol)
 r.extend(p) if p else r.append(dict(start=start,end=end,symbol=symbol))
for n in t.body:
 start=begin(n)
 if isinstance(n,ast.ClassDef):
  r.append(dict(start=start,end=n.body[0].lineno-1,symbol=n.name))
  for m in n.body:
   emit(m,begin(m),m.end_lineno,n.name+'.'+getattr(m,'name','body'))
 else:emit(n,start,n.end_lineno,getattr(n,'name',None))
print(json.dumps(r))`;
    const result = spawnSync('python3', ['-I', '-c', script], { input: text, encoding: 'utf8', timeout: 3000, maxBuffer: 2 * 1024 * 1024 });
    if (result.status === 0) { ranges = JSON.parse(result.stdout); parser = 'python'; context = header; }
  }
  if (!ranges?.length) return { chunks: chunks(text, path, 60, 10), parser: 'overlapping-lines' };
  // Imports and one-line declarations are rarely an answer on their own and
  // each one costs a judgment, so gather runs of short neighbours into one
  // target. Only adjacent ranges merge, so line coverage stays exact. Names are
  // kept the way a multiple declarator already reads ("runtime, maxDuration"),
  // and class members stay separate so one is never folded into its header.
  const mergeable = range => range.end - range.start <= 1 && !range.symbol?.includes('.');
  const merged = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && mergeable(last) && mergeable(range) && range.start <= last.end + 1 && range.end - last.start < 12 && `${last.symbol} ${range.symbol}`.length < 60) {
      last.end = range.end;
      last.symbol = [...new Set([last.symbol, range.symbol].filter(Boolean))].join(', ') || undefined;
    } else merged.push({ ...range });
  }
  ranges = merged;
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
