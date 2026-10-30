import { Global, Module } from '@nestjs/common';

import { Locker } from './locker';
import { Mutex, RequestMutex } from './mutex';

@Global()
@Module({
  providers: [Mutex, RequestMutex, Locker],
  exports: [Mutex, RequestMutex, Locker],
})
export class MutexModule {}

export { Locker, Mutex, RequestMutex };
export { Lock } from './lock';
