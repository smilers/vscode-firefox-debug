import { config } from 'dotenv';
import fs from 'fs-extra';

config({ path: 'src/test/.env'});

export const mochaHooks = {
	async beforeAll() {
		if (process.env['FIREFOX_PROFILE_DIR'] && process.env['KEEP_PROFILE_CHANGES'] === 'true') {
			await fs.remove(process.env['FIREFOX_PROFILE_DIR']);
		}
	}
};
