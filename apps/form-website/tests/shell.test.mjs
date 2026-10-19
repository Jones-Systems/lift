import {registerSourceTests as shellTests} from '../src/shell.mjs';
import {registerSourceTests as marketingTests} from '../src/marketing.mjs';
await shellTests();
await marketingTests();
