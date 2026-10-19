const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.resolve(__dirname, '../src/variants');
const visual = /^(?:color|backgroundColor|border.*Color|fontFamily|fontSize|lineHeight|letterSpacing|padding.*|margin.*|gap|rowGap|columnGap|width|height|minWidth|minHeight|maxWidth|maxHeight|top|right|bottom|left|border.*Width|border.*Radius|shadowRadius|shadowColor|shadowOpacity|opacity|elevation)$/;
const issues = [];

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? files(file) : /\.tsx?$/.test(file) ? [file] : [];
  });
}

for (const file of files(root)) {
  if (/tokens(?:\.generated)?\.ts$/.test(file) || file.includes(`${path.sep}assets${path.sep}`)) continue;
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  function inspect(node) {
    if (ts.isPropertyAssignment(node)) {
      const name = node.name.getText(source).replace(/^['"]|['"]$/g, '');
      const value = node.initializer;
      const literal = ts.isNumericLiteral(value) || ts.isStringLiteral(value)
        || (ts.isPrefixUnaryExpression(value) && ts.isNumericLiteral(value.operand));
      if (visual.test(name) && literal) {
        const text = value.getText(source).replace(/^['"]|['"]$/g, '');
        const intrinsic = text === '0' || text === '100%' || text === 'auto'
          || (name === 'opacity' && text === '1');
        if (!intrinsic) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
          issues.push(`${path.relative(root, file)}:${line + 1} ${name}: ${value.getText(source)}`);
        }
      }
    }
    ts.forEachChild(node, inspect);
  }
  inspect(source);
}

if (issues.length) {
  process.stderr.write(`Visual literals must come from generated tokens:\n${issues.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('Variant styles contain no unapproved visual literals.\n');
}
