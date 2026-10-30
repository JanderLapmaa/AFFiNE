import { Module } from '@nestjs/common';

import { DocStorageModule } from '../doc';
import { PermissionModule } from '../permission';
import { TaskExtractor } from './extractor';
import { TaskResolver } from './resolver';
import { TaskService } from './service';

@Module({
  imports: [DocStorageModule, PermissionModule],
  providers: [TaskExtractor, TaskService, TaskResolver],
})
export class TaskModule {}
