import * as ts from 'typescript';
import type { WorkspaceMapSymbolSummary } from './workspaceToolUtils';

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateLine(value: string, maxLength: number = 160): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}...`;
}

function normalizeStubLine(line: string): string {
  return truncateLine(
    collapseWhitespace(line)
      .replace(/\s*\{$/, ' {')
      .replace(/\s*=>\s*\{$/, ' => {')
  );
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && Boolean(ts.getModifiers(node)?.some((modifier) => modifier.kind === kind));
}

function scriptKindForProjectMap(path: string): ts.ScriptKind {
  const extension = path.split('.').pop()?.toLowerCase();
  switch (extension) {
    case 'tsx':
      return ts.ScriptKind.TSX;
    case 'jsx':
      return ts.ScriptKind.JSX;
    case 'js':
    case 'mjs':
    case 'cjs':
      return ts.ScriptKind.JS;
    case 'ts':
    case 'mts':
    case 'cts':
    default:
      return ts.ScriptKind.TS;
  }
}

function typeParametersText(
  typeParameters: ts.NodeArray<ts.TypeParameterDeclaration> | undefined,
  sourceFile: ts.SourceFile
): string {
  if (!typeParameters?.length) {
    return '';
  }

  return `<${typeParameters.map((parameter) => collapseWhitespace(parameter.getText(sourceFile))).join(', ')}>`;
}

function parametersText(parameters: readonly ts.ParameterDeclaration[], sourceFile: ts.SourceFile): string {
  return parameters.map((parameter) => collapseWhitespace(parameter.getText(sourceFile))).join(', ');
}

function returnTypeText(node: { type?: ts.TypeNode }, sourceFile: ts.SourceFile): string {
  return node.type ? `: ${collapseWhitespace(node.type.getText(sourceFile))}` : '';
}

function heritageText(
  heritageClauses: ts.NodeArray<ts.HeritageClause> | undefined,
  sourceFile: ts.SourceFile
): string {
  return heritageClauses?.map((clause) => collapseWhitespace(clause.getText(sourceFile))).join(' ') ?? '';
}

function symbolLine(node: ts.Node, sourceFile: ts.SourceFile): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function bindingNameText(name: ts.BindingName): string | undefined {
  return ts.isIdentifier(name) ? name.text : undefined;
}

function propertyNameText(name: ts.PropertyName | undefined, sourceFile: ts.SourceFile): string | undefined {
  if (!name) {
    return undefined;
  }

  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isPrivateIdentifier(name)) {
    return name.text;
  }

  if (ts.isComputedPropertyName(name)) {
    return collapseWhitespace(name.expression.getText(sourceFile));
  }

  return undefined;
}

function initializerPreview(initializer: ts.Expression, sourceFile: ts.SourceFile): string {
  if (ts.isArrowFunction(initializer)) {
    return `${hasModifier(initializer, ts.SyntaxKind.AsyncKeyword) ? 'async ' : ''}${typeParametersText(initializer.typeParameters, sourceFile)}(${parametersText(initializer.parameters, sourceFile)})${returnTypeText(initializer, sourceFile)} =>`;
  }

  if (ts.isFunctionExpression(initializer)) {
    return `${hasModifier(initializer, ts.SyntaxKind.AsyncKeyword) ? 'async ' : ''}function${typeParametersText(initializer.typeParameters, sourceFile)}(${parametersText(initializer.parameters, sourceFile)})${returnTypeText(initializer, sourceFile)}`;
  }

  if (ts.isClassExpression(initializer)) {
    return `class${initializer.name ? ` ${initializer.name.text}` : ''}`;
  }

  if (ts.isCallExpression(initializer)) {
    return `${collapseWhitespace(initializer.expression.getText(sourceFile))}(...)`;
  }

  if (ts.isNewExpression(initializer)) {
    return `new ${collapseWhitespace(initializer.expression.getText(sourceFile))}(...)`;
  }

  if (ts.isObjectLiteralExpression(initializer)) {
    return '{ ... }';
  }

  if (ts.isArrayLiteralExpression(initializer)) {
    return '[...]';
  }

  return collapseWhitespace(initializer.getText(sourceFile));
}

function variableKeyword(node: ts.VariableDeclarationList): 'const' | 'let' | 'var' {
  if ((node.flags & ts.NodeFlags.Const) !== 0) {
    return 'const';
  }
  if ((node.flags & ts.NodeFlags.Let) !== 0) {
    return 'let';
  }
  return 'var';
}

export function extractTypeScriptProjectMapSymbols(
  path: string,
  content: string,
  maxSymbols: number = 8
): WorkspaceMapSymbolSummary[] {
  const sourceFile = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, scriptKindForProjectMap(path));
  const symbols: WorkspaceMapSymbolSummary[] = [];
  const seen = new Set<string>();
  const limit = Math.max(1, maxSymbols);

  const pushSymbol = (symbol: WorkspaceMapSymbolSummary | null | undefined): boolean => {
    if (!symbol) {
      return false;
    }

    const normalizedSignature = normalizeStubLine(symbol.signature);
    if (!normalizedSignature) {
      return false;
    }

    const next = {
      ...symbol,
      signature: normalizedSignature,
    } satisfies WorkspaceMapSymbolSummary;
    const key = `${next.line}:${next.kind}:${next.containerName ?? ''}:${next.name}:${next.signature}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    symbols.push(next);
    return symbols.length >= limit;
  };

  const visitClassMembers = (declaration: ts.ClassDeclaration, exported: boolean): void => {
    const className = declaration.name?.text ?? 'default';
    for (const member of declaration.members) {
      if (symbols.length >= limit) {
        return;
      }

      if (
        !ts.isMethodDeclaration(member) &&
        !ts.isGetAccessorDeclaration(member) &&
        !ts.isSetAccessorDeclaration(member)
      ) {
        continue;
      }

      if (hasModifier(member, ts.SyntaxKind.PrivateKeyword) || (member.name && ts.isPrivateIdentifier(member.name))) {
        continue;
      }

      const memberName = propertyNameText(member.name, sourceFile);
      if (!memberName) {
        continue;
      }

      const prefixParts: string[] = [];
      if (hasModifier(member, ts.SyntaxKind.StaticKeyword)) {
        prefixParts.push('static');
      }

      if (ts.isMethodDeclaration(member) && hasModifier(member, ts.SyntaxKind.AsyncKeyword)) {
        prefixParts.push('async');
      }

      const kind = ts.isMethodDeclaration(member) ? 'method' : 'accessor';
      const signature = ts.isGetAccessorDeclaration(member)
        ? `${prefixParts.join(' ')}${prefixParts.length > 0 ? ' ' : ''}get ${className}.${memberName}()${returnTypeText(member, sourceFile)}`
        : ts.isSetAccessorDeclaration(member)
          ? `${prefixParts.join(' ')}${prefixParts.length > 0 ? ' ' : ''}set ${className}.${memberName}(${parametersText(member.parameters, sourceFile)})`
          : `${prefixParts.join(' ')}${prefixParts.length > 0 ? ' ' : ''}${className}.${memberName}${typeParametersText(member.typeParameters, sourceFile)}(${parametersText(member.parameters, sourceFile)})${returnTypeText(member, sourceFile)}`;

      if (
        pushSymbol({
          name: memberName,
          kind,
          signature,
          line: symbolLine(member, sourceFile),
          containerName: className,
          exported,
          async: ts.isMethodDeclaration(member) ? hasModifier(member, ts.SyntaxKind.AsyncKeyword) : false,
        })
      ) {
        return;
      }
    }
  };

  const visitStatement = (statement: ts.Statement): void => {
    if (symbols.length >= limit) {
      return;
    }

    if (ts.isFunctionDeclaration(statement)) {
      const name = statement.name?.text ?? (hasModifier(statement, ts.SyntaxKind.DefaultKeyword) ? 'default' : undefined);
      if (!name) {
        return;
      }

      pushSymbol({
        name,
        kind: 'function',
        signature: `${hasModifier(statement, ts.SyntaxKind.ExportKeyword) ? 'export ' : ''}${hasModifier(statement, ts.SyntaxKind.DefaultKeyword) ? 'default ' : ''}${hasModifier(statement, ts.SyntaxKind.AsyncKeyword) ? 'async ' : ''}function ${name}${typeParametersText(statement.typeParameters, sourceFile)}(${parametersText(statement.parameters, sourceFile)})${returnTypeText(statement, sourceFile)}`,
        line: symbolLine(statement, sourceFile),
        exported: hasModifier(statement, ts.SyntaxKind.ExportKeyword),
        async: hasModifier(statement, ts.SyntaxKind.AsyncKeyword),
      });
      return;
    }

    if (ts.isClassDeclaration(statement)) {
      const name = statement.name?.text ?? (hasModifier(statement, ts.SyntaxKind.DefaultKeyword) ? 'default' : undefined);
      if (!name) {
        return;
      }

      const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
      const heritage = heritageText(statement.heritageClauses, sourceFile);
      pushSymbol({
        name,
        kind: 'class',
        signature: `${exported ? 'export ' : ''}${hasModifier(statement, ts.SyntaxKind.DefaultKeyword) ? 'default ' : ''}${hasModifier(statement, ts.SyntaxKind.AbstractKeyword) ? 'abstract ' : ''}class ${name}${typeParametersText(statement.typeParameters, sourceFile)}${heritage ? ` ${heritage}` : ''}`,
        line: symbolLine(statement, sourceFile),
        exported,
      });
      visitClassMembers(statement, exported);
      return;
    }

    if (ts.isInterfaceDeclaration(statement)) {
      const heritage = heritageText(statement.heritageClauses, sourceFile);
      pushSymbol({
        name: statement.name.text,
        kind: 'interface',
        signature: `${hasModifier(statement, ts.SyntaxKind.ExportKeyword) ? 'export ' : ''}interface ${statement.name.text}${typeParametersText(statement.typeParameters, sourceFile)}${heritage ? ` ${heritage}` : ''}`,
        line: symbolLine(statement, sourceFile),
        exported: hasModifier(statement, ts.SyntaxKind.ExportKeyword),
      });
      return;
    }

    if (ts.isTypeAliasDeclaration(statement)) {
      pushSymbol({
        name: statement.name.text,
        kind: 'type',
        signature: `${hasModifier(statement, ts.SyntaxKind.ExportKeyword) ? 'export ' : ''}type ${statement.name.text}${typeParametersText(statement.typeParameters, sourceFile)} = ${collapseWhitespace(statement.type.getText(sourceFile))}`,
        line: symbolLine(statement, sourceFile),
        exported: hasModifier(statement, ts.SyntaxKind.ExportKeyword),
      });
      return;
    }

    if (ts.isEnumDeclaration(statement)) {
      pushSymbol({
        name: statement.name.text,
        kind: 'enum',
        signature: `${hasModifier(statement, ts.SyntaxKind.ExportKeyword) ? 'export ' : ''}enum ${statement.name.text}`,
        line: symbolLine(statement, sourceFile),
        exported: hasModifier(statement, ts.SyntaxKind.ExportKeyword),
      });
      return;
    }

    if (ts.isVariableStatement(statement)) {
      const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
      const keyword = variableKeyword(statement.declarationList);
      for (const declaration of statement.declarationList.declarations) {
        if (symbols.length >= limit) {
          return;
        }

        const name = bindingNameText(declaration.name);
        if (!name) {
          continue;
        }

        const initializer = declaration.initializer;
        const kind = initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
          ? 'function'
          : initializer && ts.isClassExpression(initializer)
            ? 'class'
            : 'variable';
        const async = initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
          ? hasModifier(initializer, ts.SyntaxKind.AsyncKeyword)
          : false;

        if (
          pushSymbol({
            name,
            kind,
            signature: `${exported ? 'export ' : ''}${keyword} ${name}${declaration.type ? `: ${collapseWhitespace(declaration.type.getText(sourceFile))}` : ''}${initializer ? ` = ${initializerPreview(initializer, sourceFile)}` : ''}`,
            line: symbolLine(declaration, sourceFile),
            exported,
            async,
          })
        ) {
          return;
        }
      }
    }
  };

  for (const statement of sourceFile.statements) {
    visitStatement(statement);
    if (symbols.length >= limit) {
      break;
    }
  }

  return symbols;
}