import { describe, expect, test } from 'bun:test';
import { planMaven } from '../src/build-tools/maven';
import { parseArgs } from '../src/cli/args';

const config = parseArgs(['plan']);

describe('Maven 构建参数边界', () => {
  test('允许独立的属性、profile 和 settings 路径，不把路径当成目标', () => {
    const buildArgs = ['-Dcustom.value=a=b', '-Dmaven.repo.local=/tmp/repository', '-Pci', '-s', '/tmp/settings with spaces.xml', '--threads=2', '--offline'];
    expect(planMaven({ ...config, buildArgs }, '/tmp/metadata').commands[0]!.args).toContain('/tmp/settings with spaces.xml');
  });
  test.each(['deploy', 'clean', '-plapp', '--projects=other', '-fother.xml', '-am', '-N', '--fail-never', '-s', '-P', '-Doutput=other', '-Dexpression=other', '-DskipTests=false', '-Dmdep.outputFile=other', '-Dexec.mainClass=Other'])('拒绝覆盖计划或执行额外目标的参数 %s', argument => {
    expect(() => planMaven({ ...config, buildArgs: [argument] }, '/tmp/metadata')).toThrow();
  });
});
