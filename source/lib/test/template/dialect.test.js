import { assert, present } from '../harness.js';
import {
  classifyAttributeName,
  classifyBindingTarget,
  parseFragmentHead,
  refusedMember,
  securityContextFor,
  strictOperator,
} from '@core/template/dialect.js';

/**
 * The dialect is the one place that answers "what is legal in a template", and
 * both the runtime evaluator and cli/checks/template-check.mjs read their answers
 * from here. These tests pin the answers themselves, so a change to the grammar
 * is a change to a test rather than a silent change to one of the two adapters.
 */
describe('template dialect', () => {
  it('classifies attribute names into the four syntaxes', () => {
    assert.equal(classifyAttributeName('(click)').kind, 'event');
    assert.equal(classifyAttributeName('[href]').kind, 'binding');
    assert.equal(classifyAttributeName('onclick').kind, 'inline-handler');
    assert.equal(classifyAttributeName('class').kind, 'plain');
  });

  it('classifies binding targets, camel-casing properties and unwrapping booleans', () => {
    /** @param {string} target */
    const shape = (target) => {
      const { kind, name } = classifyBindingTarget(target);
      return `${kind}:${name}`;
    };

    assert.equal(shape('href'), 'attribute:href');
    assert.equal(shape('disabled'), 'boolean:disabled');
    assert.equal(shape('?hidden'), 'boolean:hidden');
    assert.equal(shape('.max-rows'), 'property:maxRows');
    // A property binding is a property first, so it is refused later by name, with a
    // message about event properties rather than inline attributes.
    assert.equal(shape('.onclick'), 'property:onclick');
    assert.equal(shape('onclick'), 'inline-handler:onclick');
    assert.equal(shape(''), 'empty-attribute:');
    assert.equal(shape('.'), 'empty-property:');
  });

  it('names one security context per sink, however the sink is reached', () => {
    assert.equal(securityContextFor('a', 'href'), 'url');
    assert.equal(securityContextFor('iframe', 'src'), 'resourceUrl');
    assert.equal(securityContextFor('img', 'src'), 'url');
    assert.equal(securityContextFor('img', 'srcset'), 'urlSet');
    assert.equal(securityContextFor('div', 'innerHTML'), 'html');
    assert.equal(securityContextFor('div', 'cssText'), 'style');
    assert.equal(securityContextFor('div', 'title'), undefined);
  });

  it('refuses reserved member names by name, not by operation', () => {
    // Both adapters ask this one question, which is what keeps a write from
    // being allowed where the matching read is refused.
    assert.includes(refusedMember('__proto__') ?? '', 'may not access "__proto__"');
    assert.equal(refusedMember('constructor') === undefined, false);
    assert.equal(refusedMember('prototype') === undefined, false);
    assert.equal(refusedMember('name'), undefined);
  });

  it('makes loose equality strict for both adapters', () => {
    assert.equal(strictOperator('=='), '===');
    assert.equal(strictOperator('!='), '!==');
    assert.equal(strictOperator('==='), '===');
    assert.equal(strictOperator('<='), '<=');
  });

  it('reads a fragment head into a property and its locals', () => {
    const cell = present(parseFragmentHead('cell(row, index)'));
    assert.equal(cell.property, 'cell');
    assert.sameArray(cell.params.map((param) => param.name), ['row', 'index']);
    assert.sameArray(cell.params.map((param) => param.iterable), [undefined, undefined]);

    assert.sameArray(present(parseFragmentHead('empty()')).params, []);

    // Kebab-cased like every other property binding, and the `of` clause names the
    // collection the local's type comes from.
    const header = present(parseFragmentHead('header-cell(row of people.list)'));
    assert.equal(header.property, 'headerCell');
    assert.sameArray(header.params.map((param) => param.iterable), ['people.list']);
  });

  it('refuses a fragment head both adapters would read differently', () => {
    assert.equal(parseFragmentHead('cell'), undefined, 'no parameter list');
    assert.equal(parseFragmentHead('cell(row'), undefined, 'unterminated');
    assert.equal(parseFragmentHead('cell(row, row)'), undefined, 'a repeated local');
    assert.equal(parseFragmentHead('cell(1row)'), undefined, 'not an identifier');
    assert.equal(parseFragmentHead('cell(row of pick(a))'), undefined, 'a call in the annotation');
  });
});
